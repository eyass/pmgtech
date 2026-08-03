-- =============================================================================
-- 0029_tenure_normalisation.sql — engineers are compared on rates, not totals
-- =============================================================================
--
-- `engineer_outliers` scores each engineer against the median and quartiles of
-- their own seniority cohort. Five of the eight inputs are running totals —
-- throughput units, issues resolved, reviews given, distinct authors reviewed,
-- reverts authored — and a total only means something if everyone had the same
-- amount of time to accumulate one. Someone who joined partway through the
-- window did not.
--
-- Aleksa Janjić is the case that surfaced this: started 2026-07-20, present for
-- 2.0 of the 12.9 weeks in the trailing-90-day window, and scored 24.3 at rank 12
-- of the org. Nothing about that number is about how he works. It is 16% of a
-- period being compared against 100% of one.
--
-- The fix is a change of unit, not a correction factor: divide each of the five
-- totals by the weeks that engineer was actually present, and compare rates to
-- rates. The useful property is that this is a no-op for anyone who was there
-- the whole time — they all divide by the same constant, and dividing a cohort
-- by a constant moves nobody's percentile. Only part-window engineers move, which
-- is the entire intent. (Cohort medians shift very slightly as those engineers
-- take their true position in the distribution; that is the correction, not a
-- side effect of it.)
--
-- Four decisions worth recording
-- ------------------------------
--   1. **A two-week floor on the divisor.** Rates from a very short presence are
--      noise, and noise divided by a small number is loud noise: one merge request
--      three days in extrapolates to a chart-topping weekly rate. `active_weeks`
--      therefore never goes below 2.0, which bounds how far anyone can be scaled
--      up. Someone present for under two weeks is still scored, just not flattered.
--      A side effect worth knowing: in a reporting window shorter than two weeks
--      the floor binds for everyone equally, so normalisation quietly becomes the
--      no-op it should be at that size.
--   2. **`sample_sufficient` stays on raw counts.** It asks "do we have enough
--      data to say anything", which is a question about totals and must not be
--      rate-normalised — otherwise two merge requests in two weeks would start
--      claiming the confidence of thirteen in thirteen. Aleksa stays `thin` after
--      this migration. What changes is that his score is now a fair estimate with
--      low confidence, instead of a confident-looking penalty for having been hired.
--   3. **Medians and percentages are left alone.** `median_cycle_hours`,
--      `review_coverage_received_pct` and `large_mr_pct` are already per-unit
--      measures and carry no time bias. Dividing them by weeks would invent one.
--   4. **The output still reports raw counts.** Only the comparison basis changes.
--      The tables on the people pages keep showing merge requests actually merged,
--      not a weekly rate nobody asked for.
--
-- Also added: a confidence reason that names partial tenure directly. It outranks
-- the `sample_sufficient` message because for a new joiner "only 2.0 of 12.9 weeks
-- here" explains the thin sample, where "fewer than 5 merge requests" only restates
-- it. `no_cohort` still outranks both.
--
-- Not done here: `engineer_profiles` computes the three bands and
-- `sample_sufficient` from the same raw totals. The bands are directional rather
-- than scored, so the distortion is milder, but it is the same distortion and it
-- wants its own migration and its own verification.
--
-- To reverse: reapply 0023's definition of engineer_outliers, which this replaces
-- verbatim apart from the CTEs named below.

drop function if exists engineer_outliers(timestamptz, timestamptz, uuid);

create or replace function engineer_outliers(
  p_from timestamptz,
  p_to   timestamptz,
  p_squad_id uuid default null
)
returns table (
  engineer_id uuid, full_name text, job_title text, seniority_key text,
  seniority_label text, peers_at_level integer, squad_id uuid, squad_key text,
  squad_name text, score numeric, rank_in_org integer, rank_at_level integer,
  score_confidence text, confidence_reason text, throughput_score numeric,
  flow_score numeric, quality_score numeric, collaboration_score numeric,
  signals_above integer, signals_below integer, signals_read integer, net integer,
  standing text, flow_band text, quality_band text, collaboration_band text,
  shape text, merged_mrs integer, issues_resolved integer, reviews_given integer,
  distinct_authors_reviewed integer, median_cycle_hours numeric,
  review_coverage_received_pct numeric, large_mr_pct numeric,
  reverts_authored integer, last_active_at timestamptz, effective_mrs numeric,
  points_per_mr numeric, median_churn numeric, trivial_mr_pct numeric,
  sized_mr_pct numeric, org_sized_mr_pct numeric, throughput_basis text
)
language sql
stable
set search_path = public, extensions
as $fn$
with p as (
  select * from engineer_profiles(p_from, p_to, null, null)
),
cx as (
  select * from engineer_complexity(p_from, p_to)
),
cov as (
  select round(100.0 * count(*) filter (where churn is not null)
               / nullif(count(*), 0)::numeric, 1)                        as org_sized_pct
  from v_mr_size
  where merged_at >= p_from and merged_at < p_to
),
win as (
  select greatest(extract(epoch from (p_to - p_from)) / 604800.0, 1.0 / 7.0) as window_weeks
),
based as (
  select
    p.*,
    cx.effective_mrs,
    cx.points_per_mr,
    cx.median_churn,
    cx.trivial_mr_pct,
    cx.sized_mr_pct,
    cov.org_sized_pct,
    ve.start_date,
    case when coalesce(cov.org_sized_pct, 0) >= 60 then 'complexity' else 'count' end as basis,
    case
      when coalesce(cov.org_sized_pct, 0) >= 60 then coalesce(cx.effective_mrs, 0)
      else p.merged_mrs::numeric
    end                                                                   as throughput_units
  from p
  left join cx  on cx.engineer_id = p.engineer_id
  left join v_engineers ve on ve.id = p.engineer_id
  cross join cov
),
tenured as (
  -- Weeks this engineer was actually present inside the window. Floored at two so
  -- a handful of days cannot become a headline rate; see note 1 above.
  select
    b.*,
    extract(epoch from (p_to - greatest(p_from, coalesce(b.start_date::timestamptz, p_from))))
      / 604800.0                                                          as raw_weeks,
    greatest(
      extract(epoch from (p_to - greatest(p_from, coalesce(b.start_date::timestamptz, p_from))))
        / 604800.0,
      2.0
    )                                                                     as active_weeks
  from based b
),
normed as (
  -- The five totals become per-week rates. Everything else is untouched.
  select
    t.*,
    t.throughput_units            / t.active_weeks                        as tp_rate,
    t.issues_resolved             / t.active_weeks                        as iss_rate,
    t.reviews_given               / t.active_weeks                        as rg_rate,
    t.distinct_authors_reviewed   / t.active_weeks                        as da_rate,
    t.reverts_authored            / t.active_weeks                        as rev_rate
  from tenured t
),
coh as (
  select
    seniority_key,
    (percentile_cont(0.5)  within group (order by tp_rate))::numeric                     as med_tp,
    (percentile_cont(0.25) within group (order by tp_rate))::numeric                     as q1_tp,
    (percentile_cont(0.75) within group (order by tp_rate))::numeric                     as q3_tp,
    (percentile_cont(0.5)  within group (order by iss_rate))::numeric                    as med_iss,
    (percentile_cont(0.25) within group (order by iss_rate))::numeric                    as q1_iss,
    (percentile_cont(0.75) within group (order by iss_rate))::numeric                    as q3_iss,
    (percentile_cont(0.5)  within group (order by median_cycle_hours))::numeric          as med_cycle,
    (percentile_cont(0.25) within group (order by median_cycle_hours))::numeric          as q1_cycle,
    (percentile_cont(0.75) within group (order by median_cycle_hours))::numeric          as q3_cycle,
    (percentile_cont(0.5)  within group (order by review_coverage_received_pct))::numeric as med_cov,
    (percentile_cont(0.25) within group (order by review_coverage_received_pct))::numeric as q1_cov,
    (percentile_cont(0.75) within group (order by review_coverage_received_pct))::numeric as q3_cov,
    (percentile_cont(0.5)  within group (order by large_mr_pct))::numeric                as med_large,
    (percentile_cont(0.25) within group (order by large_mr_pct))::numeric                as q1_large,
    (percentile_cont(0.75) within group (order by large_mr_pct))::numeric                as q3_large,
    (percentile_cont(0.5)  within group (order by rev_rate))::numeric                    as med_rev,
    (percentile_cont(0.25) within group (order by rev_rate))::numeric                    as q1_rev,
    (percentile_cont(0.75) within group (order by rev_rate))::numeric                    as q3_rev,
    (percentile_cont(0.5)  within group (order by rg_rate))::numeric                     as med_rg,
    (percentile_cont(0.25) within group (order by rg_rate))::numeric                     as q1_rg,
    (percentile_cont(0.75) within group (order by rg_rate))::numeric                     as q3_rg,
    (percentile_cont(0.5)  within group (order by da_rate))::numeric                     as med_da,
    (percentile_cont(0.25) within group (order by da_rate))::numeric                     as q1_da,
    (percentile_cont(0.75) within group (order by da_rate))::numeric                     as q3_da
  from normed
  group by seniority_key
),
scored as (
  select
    b.*,
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_cohort(b.tp_rate,  c.med_tp,  c.q1_tp,  c.q3_tp,  true),
           score_vs_cohort(b.iss_rate, c.med_iss, c.q1_iss, c.q3_iss, true)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_throughput,

    score_vs_cohort(b.median_cycle_hours, c.med_cycle, c.q1_cycle, c.q3_cycle, false)
                                                                          as s_flow,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1, 1]::numeric[],
         array[
           score_vs_cohort(b.review_coverage_received_pct, c.med_cov,   c.q1_cov,   c.q3_cov,   true),
           score_vs_cohort(b.large_mr_pct,                 c.med_large, c.q1_large, c.q3_large, false),
           score_vs_cohort(b.rev_rate,                     c.med_rev,   c.q1_rev,   c.q3_rev,   false)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_quality,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_cohort(b.rg_rate, c.med_rg, c.q1_rg, c.q3_rg, true),
           score_vs_cohort(b.da_rate, c.med_da, c.q1_da, c.q3_da, true)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_collaboration,

    (  (b.flow_band          = 'above')::int
     + (b.quality_band       = 'above')::int
     + (b.collaboration_band = 'above')::int)                             as above,
    (  (b.flow_band          = 'below')::int
     + (b.quality_band       = 'below')::int
     + (b.collaboration_band = 'below')::int)                             as below,
    (  (b.flow_band          <> 'insufficient')::int
     + (b.quality_band       <> 'insufficient')::int
     + (b.collaboration_band <> 'insufficient')::int)                     as read_count
  from normed b
  join coh c on c.seniority_key = b.seniority_key
),
composed as (
  select
    s.*,
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[25, 25, 25, 25]::numeric[],
         array[s.s_throughput, s.s_flow, s.s_quality, s.s_collaboration]
       ) as t(w, v)
      where v is not null)                                                as composite
  from scored s
),
ranked as (
  select
    c.*,
    w.window_weeks,
    c.raw_weeks < w.window_weeks * 0.75                                   as partial_tenure,
    rank() over (order by c.composite desc nulls last)                              as org_rank,
    rank() over (partition by c.seniority_key order by c.composite desc nulls last) as level_rank
  from composed c
  cross join win w
)
select
  r.engineer_id,
  r.full_name,
  r.job_title,
  r.seniority_key,
  r.seniority_label,
  r.peers_at_level,
  r.squad_id,
  r.squad_key,
  r.squad_name,

  r.composite,
  r.org_rank::int,
  r.level_rank::int,

  case
    when r.peers_at_level < 3    then 'no_cohort'
    when r.partial_tenure        then 'thin'
    when not r.sample_sufficient then 'thin'
    when r.composite is null     then 'thin'
    when r.basis = 'complexity' and coalesce(r.sized_mr_pct, 0) < 60 then 'thin'
    else 'high'
  end,
  case
    when r.peers_at_level < 3 then
      'Scored against ' || r.peers_at_level || ' at this level — too few for a median to mean much'
    when r.partial_tenure then
      'Joined partway through — here for ' || round(r.raw_weeks, 1) || ' of the '
        || round(r.window_weeks, 1) || ' weeks in this period, so their rates come from a short sample'
    when not r.sample_sufficient then
      'Fewer than 5 merged merge requests and fewer than 5 resolved issues in this period'
    when r.composite is null then
      'No dimension had any data behind it'
    when r.basis = 'complexity' and coalesce(r.sized_mr_pct, 0) < 60 then
      'Only ' || coalesce(r.sized_mr_pct, 0) || '% of their merge requests have a measured size, so weighted throughput is understated'
    else null
  end,

  r.s_throughput,
  r.s_flow,
  r.s_quality,
  r.s_collaboration,

  r.above,
  r.below,
  r.read_count,
  r.above - r.below,
  case
    when r.above > r.below then 'top'
    when r.below > r.above then 'bottom'
    when r.read_count = 0  then 'unread'
    else 'typical'
  end,
  r.flow_band,
  r.quality_band,
  r.collaboration_band,
  r.shape,

  r.merged_mrs,
  r.issues_resolved,
  r.reviews_given,
  r.distinct_authors_reviewed,
  r.median_cycle_hours,
  r.review_coverage_received_pct,
  r.large_mr_pct,
  r.reverts_authored,
  r.last_active_at,

  r.effective_mrs,
  r.points_per_mr,
  r.median_churn,
  r.trivial_mr_pct,
  r.sized_mr_pct,
  r.org_sized_pct,
  r.basis
from ranked r
where p_squad_id is null or r.squad_id = p_squad_id
order by r.composite desc nulls last, r.full_name;
$fn$;

comment on function engineer_outliers(timestamptz, timestamptz, uuid) is
  'Engineers scored 0-100 against their own seniority cohort. Volume inputs are compared as per-active-week rates so engineers who joined partway through the period are not penalised for the weeks before they arrived; medians and percentages are compared as-is. Throughput counts complexity-weighted merge requests once the org has measured 60% of them, raw counts below that, with throughput_basis saying which.';

-- --- grants -------------------------------------------------------------------
-- Restated because the drop above cleared the ACL. Same posture as before.

revoke all on function engineer_outliers(timestamptz, timestamptz, uuid) from public, anon;

grant execute on function engineer_outliers(timestamptz, timestamptz, uuid) to authenticated, service_role;
