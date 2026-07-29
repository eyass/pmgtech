-- =============================================================================
-- 0023_complexity_weighted_throughput.sql — throughput in median-MR units
-- =============================================================================
--
-- 0022 measures how much a merge request contains. This spends that measurement:
-- the throughput dimension of both scores now counts complexity-weighted merge
-- requests instead of merge requests, so twenty ten-line changes stop being worth
-- twenty units and start being worth two.
--
-- The unit is "median merged merge request over the period", which is what makes
-- this substitutable at all: a squad shipping median-sized work at four per
-- engineer per week scores the same as it did before, and only the teams whose
-- average change is unusually small or unusually large move. The absolute squad
-- targets from 0021 therefore keep their meaning and are left alone.
--
-- One decision worth stating plainly, because it is the difference between a
-- ranking and a mess: **the basis is chosen once, org-wide, not per engineer.**
-- Mixing weighted and unweighted rows inside one seniority cohort would put two
-- different units in the same percentile, and the median would be meaningless.
-- So if the org has measured at least 60% of its merged merge requests, everyone
-- is scored on weighted units; below that, everyone is scored on raw counts and
-- `throughput_basis` says so on every row.
--
-- The transitional state is real and has to be visible rather than smoothed over:
-- at the time this ships, coverage is 0%, because sizes were never collected until
-- 0022. So the score continues to behave exactly as before, on raw counts, and
-- flips to weighted units by itself once the sync's size backfill has worked
-- through history. Nothing here pretends to have data it does not have.
--
-- Per-engineer coverage is reported separately (`sized_mr_pct`), because org-wide
-- coverage above the floor does not guarantee it for an individual, and someone
-- whose own merge requests are mostly unmeasured has an understated weighted total
-- until the backfill reaches them. That downgrades their confidence flag rather
-- than silently altering their rank.

-- --- engineers ----------------------------------------------------------------

drop function if exists engineer_outliers(timestamptz, timestamptz, uuid);

create or replace function engineer_outliers(
  p_from     timestamptz,
  p_to       timestamptz,
  p_squad_id uuid default null
)
returns table (
  engineer_id        uuid,
  full_name          text,
  job_title          text,
  seniority_key      text,
  seniority_label    text,
  peers_at_level     int,
  squad_id           uuid,
  squad_key          text,
  squad_name         text,
  score              numeric,
  rank_in_org        int,
  rank_at_level      int,
  score_confidence   text,
  confidence_reason  text,
  throughput_score   numeric,
  flow_score         numeric,
  quality_score      numeric,
  collaboration_score numeric,
  signals_above      int,
  signals_below      int,
  signals_read       int,
  net                int,
  standing           text,
  flow_band          text,
  quality_band       text,
  collaboration_band text,
  shape              text,
  merged_mrs         int,
  issues_resolved    int,
  reviews_given      int,
  distinct_authors_reviewed int,
  median_cycle_hours numeric,
  review_coverage_received_pct numeric,
  large_mr_pct       numeric,
  reverts_authored   int,
  last_active_at     timestamptz,
  -- complexity, and how much of it rests on a real measurement
  effective_mrs      numeric,
  points_per_mr      numeric,
  median_churn       numeric,
  trivial_mr_pct     numeric,
  sized_mr_pct       numeric,
  org_sized_mr_pct   numeric,
  throughput_basis   text
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
-- One number decides the unit for everybody. 60% is the floor: below it the
-- weighted total is built on a minority of the work and the raw count is the more
-- honest of two imperfect answers.
cov as (
  -- One definition of "how much of the work has been measured", shared by both
  -- functions so the basis can never flip for engineers and not for squads.
  select round(100.0 * count(*) filter (where churn is not null)
               / nullif(count(*), 0)::numeric, 1)                        as org_sized_pct
  from v_mr_size
  where merged_at >= p_from and merged_at < p_to
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
    case when coalesce(cov.org_sized_pct, 0) >= 60 then 'complexity' else 'count' end as basis,
    case
      when coalesce(cov.org_sized_pct, 0) >= 60 then coalesce(cx.effective_mrs, 0)
      else p.merged_mrs::numeric
    end                                                                   as throughput_units
  from p
  left join cx  on cx.engineer_id = p.engineer_id
  cross join cov
),
coh as (
  select
    seniority_key,
    (percentile_cont(0.5)  within group (order by throughput_units))::numeric            as med_tp,
    (percentile_cont(0.25) within group (order by throughput_units))::numeric            as q1_tp,
    (percentile_cont(0.75) within group (order by throughput_units))::numeric            as q3_tp,
    (percentile_cont(0.5)  within group (order by issues_resolved))::numeric             as med_iss,
    (percentile_cont(0.25) within group (order by issues_resolved))::numeric             as q1_iss,
    (percentile_cont(0.75) within group (order by issues_resolved))::numeric             as q3_iss,
    (percentile_cont(0.5)  within group (order by median_cycle_hours))::numeric          as med_cycle,
    (percentile_cont(0.25) within group (order by median_cycle_hours))::numeric          as q1_cycle,
    (percentile_cont(0.75) within group (order by median_cycle_hours))::numeric          as q3_cycle,
    (percentile_cont(0.5)  within group (order by review_coverage_received_pct))::numeric as med_cov,
    (percentile_cont(0.25) within group (order by review_coverage_received_pct))::numeric as q1_cov,
    (percentile_cont(0.75) within group (order by review_coverage_received_pct))::numeric as q3_cov,
    (percentile_cont(0.5)  within group (order by large_mr_pct))::numeric                as med_large,
    (percentile_cont(0.25) within group (order by large_mr_pct))::numeric                as q1_large,
    (percentile_cont(0.75) within group (order by large_mr_pct))::numeric                as q3_large,
    (percentile_cont(0.5)  within group (order by reverts_authored))::numeric            as med_rev,
    (percentile_cont(0.25) within group (order by reverts_authored))::numeric            as q1_rev,
    (percentile_cont(0.75) within group (order by reverts_authored))::numeric            as q3_rev,
    (percentile_cont(0.5)  within group (order by reviews_given))::numeric               as med_rg,
    (percentile_cont(0.25) within group (order by reviews_given))::numeric               as q1_rg,
    (percentile_cont(0.75) within group (order by reviews_given))::numeric               as q3_rg,
    (percentile_cont(0.5)  within group (order by distinct_authors_reviewed))::numeric    as med_da,
    (percentile_cont(0.25) within group (order by distinct_authors_reviewed))::numeric    as q1_da,
    (percentile_cont(0.75) within group (order by distinct_authors_reviewed))::numeric    as q3_da
  from based
  group by seniority_key
),
scored as (
  select
    b.*,
    -- Throughput. The merge-request half is now weighted by how much each change
    -- contained; issues stay a plain count because Jira has no comparable size.
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_cohort(b.throughput_units, c.med_tp,  c.q1_tp,  c.q3_tp,  true),
           score_vs_cohort(b.issues_resolved,  c.med_iss, c.q1_iss, c.q3_iss, true)
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
           score_vs_cohort(b.reverts_authored,             c.med_rev,   c.q1_rev,   c.q3_rev,   false)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_quality,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_cohort(b.reviews_given,             c.med_rg, c.q1_rg, c.q3_rg, true),
           score_vs_cohort(b.distinct_authors_reviewed, c.med_da, c.q1_da, c.q3_da, true)
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
  from based b
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
    rank() over (order by c.composite desc nulls last)                              as org_rank,
    rank() over (partition by c.seniority_key order by c.composite desc nulls last) as level_rank
  from composed c
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
    when not r.sample_sufficient then 'thin'
    when r.composite is null     then 'thin'
    -- Scored on weighted units while most of this person's own merge requests are
    -- still unmeasured: their weighted total is an understatement until the size
    -- backfill reaches them, and that belongs on the row rather than in a footnote.
    when r.basis = 'complexity' and coalesce(r.sized_mr_pct, 0) < 60 then 'thin'
    else 'high'
  end,
  case
    when r.peers_at_level < 3 then
      'Scored against ' || r.peers_at_level || ' at this level — too few for a median to mean much'
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
  'Engineers scored 0-100 against their own seniority cohort. Throughput counts complexity-weighted merge requests once the org has measured 60% of them, raw counts below that, with throughput_basis saying which.';

-- --- squads -------------------------------------------------------------------

drop function if exists squad_outliers(timestamptz, timestamptz);

create or replace function squad_outliers(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  squad_id      uuid,
  squad_key     text,
  squad_name    text,
  colour        text,
  headcount     int,
  score         numeric,
  rank_in_org   int,
  score_confidence text,
  confidence_reason text,
  throughput_score   numeric,
  flow_score         numeric,
  quality_score      numeric,
  collaboration_score numeric,
  mrs_per_engineer_week    numeric,
  deploys_per_week         numeric,
  median_cycle_hours       numeric,
  change_failure_pct       numeric,
  mttr_hours               numeric,
  review_coverage_pct      numeric,
  reviews_per_engineer_week numeric,
  cycle_sample  int,
  deploy_sample int,
  mttr_sample   int,
  -- complexity
  effective_mrs                numeric,
  effective_mrs_per_engineer_week numeric,
  points_per_mr                numeric,
  median_churn                 numeric,
  trivial_mr_pct               numeric,
  sized_mr_pct                 numeric,
  throughput_basis             text
)
language sql
stable
set search_path = public, extensions
as $fn$
with s as (
  select * from squad_scorecards(p_from, p_to)
),
live as (
  select * from s where headcount > 0 or merged_mrs > 0
),
cx as (
  select * from squad_complexity(p_from, p_to)
),
span as (
  select greatest(extract(epoch from (p_to - p_from)) / 604800.0, 1.0 / 7.0) as weeks
),
cov as (
  -- One definition of "how much of the work has been measured", shared by both
  -- functions so the basis can never flip for engineers and not for squads.
  select round(100.0 * count(*) filter (where churn is not null)
               / nullif(count(*), 0)::numeric, 1)                        as org_sized_pct
  from v_mr_size
  where merged_at >= p_from and merged_at < p_to
),
based as (
  select
    l.*,
    cx.effective_mrs,
    cx.points_per_mr,
    cx.median_churn,
    cx.trivial_mr_pct,
    cx.sized_mr_pct,
    cov.org_sized_pct,
    case when coalesce(cov.org_sized_pct, 0) >= 60 then 'complexity' else 'count' end as basis,
    -- Same unit as the raw rate — median merge requests per engineer per week — so
    -- the 4/1 target from 0021 keeps meaning exactly what it meant.
    case
      when l.headcount > 0 and cx.effective_mrs is not null
        then round(cx.effective_mrs / l.headcount / (select weeks from span), 2)
    end                                                                              as eff_rate
  from live l
  left join cx on cx.squad_id = l.squad_id
  cross join cov
),
scored as (
  select
    b.*,
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_target(
             case when b.basis = 'complexity' then b.eff_rate else b.mrs_per_engineer_week end,
             4, 1),
           score_vs_target(b.deploys_per_week, 5, 1)
         ]
       ) as t(w, v)
      where v is not null)                                              as s_throughput,

    score_vs_target(b.median_cycle_hours, 24, 120)                      as s_flow,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[1, 1]::numeric[],
         array[
           score_vs_target(b.change_failure_pct, 15, 30),
           score_vs_target(b.mttr_hours,          4, 24)
         ]
       ) as t(w, v)
      where v is not null)                                              as s_quality,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[1, 1]::numeric[],
         array[
           score_vs_target(b.review_coverage_pct, 90, 60),
           case when b.headcount >= 2
                then score_vs_target(b.reviews_per_engineer_week, 8, 2) end
         ]
       ) as t(w, v)
      where v is not null)                                              as s_collaboration
  from based b
),
composed as (
  select
    sc.*,
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[25, 25, 25, 25]::numeric[],
         array[sc.s_throughput, sc.s_flow, sc.s_quality, sc.s_collaboration]
       ) as t(w, v)
      where v is not null)                                              as composite
  from scored sc
)
select
  c.squad_id,
  c.squad_key,
  c.squad_name,
  c.colour,
  c.headcount,
  c.composite,
  rank() over (order by c.composite desc nulls last)::int,
  case
    when c.composite is null                          then 'thin'
    when c.headcount < 2                              then 'thin'
    when c.cycle_sample < 20 and c.deploy_sample < 20 then 'thin'
    when c.basis = 'complexity' and coalesce(c.sized_mr_pct, 0) < 60 then 'thin'
    else 'high'
  end,
  case
    when c.composite is null then 'Nothing measurable landed for this squad in the period'
    when c.headcount < 2 then
      'One person in metrics, so the per-engineer rates are an individual''s rates'
    when c.cycle_sample < 20 and c.deploy_sample < 20 then
      'Fewer than 20 merge requests and fewer than 20 production releases behind the medians'
    when c.basis = 'complexity' and coalesce(c.sized_mr_pct, 0) < 60 then
      'Only ' || coalesce(c.sized_mr_pct, 0) || '% of this squad''s merge requests have a measured size'
    else null
  end,
  c.s_throughput,
  c.s_flow,
  c.s_quality,
  c.s_collaboration,

  c.mrs_per_engineer_week,
  c.deploys_per_week,
  c.median_cycle_hours,
  c.change_failure_pct,
  c.mttr_hours,
  c.review_coverage_pct,
  c.reviews_per_engineer_week,

  c.cycle_sample,
  c.deploy_sample,
  c.mttr_sample,

  c.effective_mrs,
  c.eff_rate,
  c.points_per_mr,
  c.median_churn,
  c.trivial_mr_pct,
  c.sized_mr_pct,
  c.basis
from composed c
order by c.composite desc nulls last, c.squad_name;
$fn$;

comment on function squad_outliers(timestamptz, timestamptz) is
  'Squads scored 0-100 against absolute targets. Throughput uses complexity-weighted merge requests per engineer per week once the org has measured 60% of them, keeping the same unit and target as the raw rate.';

revoke all on function engineer_outliers(timestamptz, timestamptz, uuid) from public, anon;
revoke all on function squad_outliers(timestamptz, timestamptz)          from public, anon;

grant execute on function engineer_outliers(timestamptz, timestamptz, uuid) to authenticated, service_role;
grant execute on function squad_outliers(timestamptz, timestamptz)          to authenticated, service_role;
