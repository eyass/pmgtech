-- =============================================================================
-- 0028_tenure_normalisation.sql — score people for the time they were here
-- =============================================================================
--
-- `engineer_outliers(from, to)` measured everyone against the window, with no
-- regard for whether they were employed for it. On the 90-day window, in this
-- database, today:
--
--   Aleksa Janjić   start 2026-07-20   present 11 of 90 days   score 24.0, rank 12
--   everyone else   start 2021-2025    present 90 of 90 days
--
-- Eleven days of work was compared against ninety days of work, and the composite
-- published 24.0 and a twelfth place off the back of it. The existing `thin` flag
-- caught the symptom — two merged merge requests — and said nothing about the
-- cause. Worse, and much less visible: he sat inside the nine-person Senior
-- Engineer cohort, so his eleven days pulled down the median that his eight peers'
-- *relative* scores are measured against. One person's uncertain number is a
-- labelling problem. Eight people's certain numbers being quietly wrong is not.
--
-- Three changes, each defended below where it is made:
--
--   1. Rate-based inputs are prorated by days actually present, not window length.
--   2. Anyone below a minimum presence is excluded from the cohort median and from
--      the ranked set, so their partial window cannot move anyone else.
--   3. The row says so, in `score_confidence` / `confidence_reason`, rather than
--      publishing a bare number with a caveat the reader has to reconstruct.
--
-- What is deliberately NOT here: no change to `engineer_profiles` (0018 owns it,
-- and its bands feed pages beyond this one), no change to `squad_outliers` (a
-- squad's absolute targets do not have a tenure), and no change to the raw inputs
-- returned for display. `merged_mrs` stays the number of merge requests the person
-- merged. The prorated figures are returned beside it as their own columns, because
-- a score that cannot be reconciled with the counts printed next to it is exactly
-- the rumour 0021 set out not to produce.

-- --- the presence floor -------------------------------------------------------
--
-- One number, one place, callable from SQL, mirrored once in TypeScript
-- (`src/lib/tenure.ts`) for the admin screen and the tests. Same shape as 0023's
-- 60% complexity-coverage floor, and for the same reason: this is a statistical
-- guardrail, not a policy dial.
--
-- Why not a `metric_targets` row (0027)? Because that table's own comment says
-- "Squads only — nothing here is ever applied to a person", and this is applied to
-- nothing but people. Its CHECK constraints are about good/bad direction, which
-- this has no analogue of, and its audit trail exists to explain a squad score
-- moving. Putting a person-scoring floor in there would contradict the table on
-- the first line of its own documentation.
--
-- Why one half, specifically:
--
--   * **Proration multiplies the noise as well as the signal.** Dividing by the
--     presence fraction scales the observation by 1/f. At f = 0.5 the published
--     figure is twice what was seen; at f = 0.12 — Aleksa's eleven days — it is
--     8.2 times what was seen, and seven eighths of that number is extrapolation.
--     A median assembled from rows like that is a median of guesses. Half the
--     window is the point at which the observation still outweighs the inference.
--   * **It is the same reasoning the rest of the app already applies, not a new
--     philosophy.** 0018 refuses to call a band 'above' or 'below' until the gap
--     clears an absolute materiality gate, because a rank computed on noise starts
--     a conversation the data cannot support. The framework suppresses cohort
--     comparison below three peers, because a median over two people is those two
--     people. Both are the same move: withhold the comparison until the input can
--     carry it. This withholds cohort *membership* until the window can carry it.
--   * **It is a floor on defining the yardstick, not on being measured.** Below it
--     an engineer still gets a score, still gets their sub-scores, and still
--     appears. What they lose is the ability to move everybody else.
--
-- Nobody in this database currently sits between 50% and 100%, so where exactly
-- the line falls inside that band moves no score today. It is placed where the
-- argument puts it rather than where the data happens to be empty.

create or replace function tenure_presence_floor()
returns numeric
language sql
immutable
set search_path = public, extensions
as $$ select 0.5::numeric $$;

comment on function tenure_presence_floor() is
  'Minimum share of the scoring window an engineer must have been employed for before their row may define their cohort''s median or take a place in the ranked set. Below it the score is still produced, and labelled.';

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
  effective_mrs      numeric,
  points_per_mr      numeric,
  median_churn       numeric,
  trivial_mr_pct     numeric,
  sized_mr_pct       numeric,
  org_sized_mr_pct   numeric,
  throughput_basis   text,
  -- tenure, and what it did to the score
  start_date         date,
  days_in_window     int,
  days_present       int,
  presence_pct       numeric,
  in_cohort_median   boolean,
  cohort_scored_peers int,
  throughput_units_prorated numeric,
  issues_resolved_prorated  numeric,
  reviews_given_prorated    numeric,
  reverts_authored_prorated numeric
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
-- Whole days, in UTC, matching how 0025 stamps a snapshot's `captured_for` — the
-- window a score is labelled with and the window it is divided by have to be the
-- same window. Whole days rather than a fractional epoch span so the arithmetic
-- and the sentence the row prints ("11 of 90 days") are the same two numbers: a
-- reader who divides them lands on the factor that was actually applied.
win as (
  select
    (p_from at time zone 'utc')::date                                        as w_from,
    (p_to   at time zone 'utc')::date                                        as w_to,
    greatest((p_to at time zone 'utc')::date - (p_from at time zone 'utc')::date, 1) as window_days
),
pres as (
  select
    e.id                                                                   as engineer_id,
    e.start_date,
    w.window_days,
    -- Days of the window on or after the start date. Clamped at both ends:
    --   * a start date before the window gives the whole window, which is the
    --     unchanged case and must divide by exactly 1.0 — see the regression note
    --     at the foot of this file;
    --   * a start date after the window end gives zero, not a negative. 2026-08-10
    --     is in this table today. A negative would invert every prorated rate and
    --     produce a confident, enormous, backwards score.
    case
      when e.start_date is null then null
      else greatest(least(w.w_to - greatest(e.start_date, w.w_from), w.window_days), 0)
    end                                                                    as days_present
  from engineers e
  cross join win w
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
    pr.start_date,
    pr.window_days,
    pr.days_present,
    (pr.start_date is not null)                                            as presence_known,
    case
      when pr.days_present is null then null
      else pr.days_present::numeric / pr.window_days
    end                                                                    as presence_fraction,
    case when coalesce(cov.org_sized_pct, 0) >= 60 then 'complexity' else 'count' end as basis,
    case
      when coalesce(cov.org_sized_pct, 0) >= 60 then coalesce(cx.effective_mrs, 0)
      else p.merged_mrs::numeric
    end                                                                    as throughput_units
  from p
  left join cx  on cx.engineer_id = p.engineer_id
  left join pres pr on pr.engineer_id = p.engineer_id
  cross join cov
),
gated as (
  select
    b.*,
    (b.presence_known and b.days_present = 0)                              as not_yet_present,
    (b.presence_known and b.presence_fraction >= tenure_presence_floor())  as in_cohort
  from based b
),
-- ---------------------------------------------------------------------------
-- Proration, metric by metric. Which side of this line an input falls on is the
-- whole of the change, so every input is named rather than swept into a rule.
--
-- PRORATED — counts that accumulate with time present. Dividing by the presence
-- fraction restates them as "the rate implied over a full window", which is the
-- unit the cohort median is already in, so the yardstick does not move and a
-- full-presence engineer divides by 1.0 and is untouched:
--
--   throughput_units   merged merge requests, complexity-weighted where 0023's
--                      org-wide coverage floor is met. A count of work done.
--   issues_resolved    a count of work done.
--   reviews_given      a count of work done.
--   reverts_authored   a count, of a bad thing, and prorated for symmetry rather
--                      than in spite of it. Leaving this one raw while prorating
--                      the three above would hand every short-tenure engineer a
--                      free quality score: zero reverts in eleven days is not the
--                      same achievement as zero in ninety, and scoring it as
--                      though it were biases the composite in one direction only.
--
-- NOT PRORATED — and each for a different reason, which is why no single rule
-- covers them:
--
--   review_coverage_received_pct   Already a percentage. It is
--                                  reviewed-MRs-over-merged-MRs, so the denominator
--                                  is the person's own work and the time they had
--                                  to do it has already divided out. Prorating a
--                                  percentage would push it past 100 and mean
--                                  nothing at all.
--   large_mr_pct                   The same: a share of their own merge requests.
--   median_cycle_hours             Neither a rate nor a count — a central tendency
--                                  over individual merge requests, in hours per
--                                  merge request. Already normalised by the unit of
--                                  work rather than by the period, so time present
--                                  does not enter it. What a short window does do
--                                  to it is leave the median resting on very few
--                                  merge requests, and that is a sample-size
--                                  problem, answered by the confidence label rather
--                                  than by arithmetic.
--   distinct_authors_reviewed      A count, but of *distinct people*, and therefore
--                                  bounded above by the size of the org rather than
--                                  by the length of the window. It saturates; it
--                                  does not accumulate. Prorating three colleagues
--                                  over eleven days would claim 24.5 distinct
--                                  colleagues over ninety, which is more people than
--                                  there are. This under-credits a short-tenure
--                                  engineer, and an honest under-credit on a
--                                  weight-1 input beats a fabricated number.
--
-- A raw count is never scored against a prorated one: the four rates are prorated
-- for *everybody*, so the cohort stays in one unit. That is the rule 0023 set when
-- it chose the throughput basis org-wide rather than per engineer, applied here for
-- the same reason — two units in one percentile is not a percentile.
--
-- Zero presence withholds every input rather than prorating by zero. Someone whose
-- start date falls after the window has no rate, and a rate of zero is a claim
-- about their output. There is nothing to claim.
-- ---------------------------------------------------------------------------
inputs as (
  select
    q.*,
    -- Null presence (no start date on record) leaves the value alone: there is no
    -- factor to apply, and inventing 1.0 would be the silent full-tenure assumption
    -- this file exists to refuse. What that row loses instead is cohort membership,
    -- its place in the ranked set, and a clean confidence flag — see the reasons
    -- below. It is not a quiet default; it is a stated one.
    case when q.not_yet_present then null
         when q.presence_fraction is null then q.throughput_units
         else round(q.throughput_units / q.presence_fraction, 2) end       as tp_rate,
    case when q.not_yet_present then null
         when q.presence_fraction is null then q.issues_resolved::numeric
         else round(q.issues_resolved / q.presence_fraction, 2) end        as iss_rate,
    case when q.not_yet_present then null
         when q.presence_fraction is null then q.reviews_given::numeric
         else round(q.reviews_given / q.presence_fraction, 2) end          as rg_rate,
    case when q.not_yet_present then null
         when q.presence_fraction is null then q.reverts_authored::numeric
         else round(q.reverts_authored / q.presence_fraction, 2) end       as rev_rate,
    -- Not prorated, but still withheld from someone who was not here.
    case when q.not_yet_present then null else q.median_cycle_hours end                 as cycle_in,
    case when q.not_yet_present then null else q.review_coverage_received_pct end       as cov_in,
    case when q.not_yet_present then null else q.large_mr_pct end                       as large_in,
    case when q.not_yet_present then null else q.distinct_authors_reviewed::numeric end as da_in
  from gated q
),
-- The cohort is now the people whose window can support one. `filter (where
-- in_cohort)` on each ordered-set aggregate rather than a WHERE on the CTE, because
-- the group itself must survive even when nobody in it qualifies: the medians then
-- come back null, every sub-score drops out and the composite is withheld — which
-- is the correct answer, and is not the same answer as the engineer disappearing
-- from the result set.
coh as (
  select
    seniority_key,
    count(*) filter (where in_cohort)::int                                                     as scored_peers,
    (percentile_cont(0.5)  within group (order by tp_rate)  filter (where in_cohort))::numeric as med_tp,
    (percentile_cont(0.25) within group (order by tp_rate)  filter (where in_cohort))::numeric as q1_tp,
    (percentile_cont(0.75) within group (order by tp_rate)  filter (where in_cohort))::numeric as q3_tp,
    (percentile_cont(0.5)  within group (order by iss_rate) filter (where in_cohort))::numeric as med_iss,
    (percentile_cont(0.25) within group (order by iss_rate) filter (where in_cohort))::numeric as q1_iss,
    (percentile_cont(0.75) within group (order by iss_rate) filter (where in_cohort))::numeric as q3_iss,
    (percentile_cont(0.5)  within group (order by cycle_in) filter (where in_cohort))::numeric as med_cycle,
    (percentile_cont(0.25) within group (order by cycle_in) filter (where in_cohort))::numeric as q1_cycle,
    (percentile_cont(0.75) within group (order by cycle_in) filter (where in_cohort))::numeric as q3_cycle,
    (percentile_cont(0.5)  within group (order by cov_in)   filter (where in_cohort))::numeric as med_cov,
    (percentile_cont(0.25) within group (order by cov_in)   filter (where in_cohort))::numeric as q1_cov,
    (percentile_cont(0.75) within group (order by cov_in)   filter (where in_cohort))::numeric as q3_cov,
    (percentile_cont(0.5)  within group (order by large_in) filter (where in_cohort))::numeric as med_large,
    (percentile_cont(0.25) within group (order by large_in) filter (where in_cohort))::numeric as q1_large,
    (percentile_cont(0.75) within group (order by large_in) filter (where in_cohort))::numeric as q3_large,
    (percentile_cont(0.5)  within group (order by rev_rate) filter (where in_cohort))::numeric as med_rev,
    (percentile_cont(0.25) within group (order by rev_rate) filter (where in_cohort))::numeric as q1_rev,
    (percentile_cont(0.75) within group (order by rev_rate) filter (where in_cohort))::numeric as q3_rev,
    (percentile_cont(0.5)  within group (order by rg_rate)  filter (where in_cohort))::numeric as med_rg,
    (percentile_cont(0.25) within group (order by rg_rate)  filter (where in_cohort))::numeric as q1_rg,
    (percentile_cont(0.75) within group (order by rg_rate)  filter (where in_cohort))::numeric as q3_rg,
    (percentile_cont(0.5)  within group (order by da_in)    filter (where in_cohort))::numeric as med_da,
    (percentile_cont(0.25) within group (order by da_in)    filter (where in_cohort))::numeric as q1_da,
    (percentile_cont(0.75) within group (order by da_in)    filter (where in_cohort))::numeric as q3_da
  from inputs
  group by seniority_key
),
scored as (
  select
    b.*,
    c.scored_peers,
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_cohort(b.tp_rate,  c.med_tp,  c.q1_tp,  c.q3_tp,  true),
           score_vs_cohort(b.iss_rate, c.med_iss, c.q1_iss, c.q3_iss, true)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_throughput,

    score_vs_cohort(b.cycle_in, c.med_cycle, c.q1_cycle, c.q3_cycle, false)
                                                                          as s_flow,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1, 1]::numeric[],
         array[
           score_vs_cohort(b.cov_in,   c.med_cov,   c.q1_cov,   c.q3_cov,   true),
           score_vs_cohort(b.large_in, c.med_large, c.q1_large, c.q3_large, false),
           score_vs_cohort(b.rev_rate, c.med_rev,   c.q1_rev,   c.q3_rev,   false)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_quality,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_cohort(b.rg_rate, c.med_rg, c.q1_rg, c.q3_rg, true),
           score_vs_cohort(b.da_in,   c.med_da, c.q1_da, c.q3_da, true)
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
  from inputs b
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
-- A rank is a positional claim inside a comparable set, and someone measured over a
-- different span is not in that set. The honest return value is therefore null, and
-- it is not what this returns: `rank_in_org` and `rank_at_level` are typed non-null
-- in `EngineerOutlier` and read by /rankings, rank-dotplot and rank-slope, so making
-- them nullable would be a change to those files rather than to this one. The
-- next-honest thing is what happens here — every qualifying row is ordered by score,
-- and the non-qualifying rows follow *after all of them* whatever they scored. The
-- integer then encodes "outside the ranked set" as "behind everyone in it", and
-- `in_cohort_median`, `score_confidence` and `confidence_reason` say it outright on
-- the same row.
ranked as (
  select
    c.*,
    rank() over (
      order by (not c.in_cohort), c.composite desc nulls last
    )                                                                     as org_rank,
    rank() over (
      partition by c.seniority_key
      order by (not c.in_cohort), c.composite desc nulls last
    )                                                                     as level_rank
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

  -- Precedence, most specific statement about *this row* first.
  --
  -- 'Not yet started' outranks even the cohort guard: whatever the cohort looks
  -- like, there is nothing here to compare. Then the cohort guard, now counting the
  -- peers who actually defined the median rather than everyone at the level — three
  -- peers on paper of whom one is eleven days old is a median over two. Then the two
  -- partial-window states, above `thin`, because 'thin' would blame the merge
  -- request count for something the start date explains.
  case
    when r.not_yet_present        then 'partial_window'
    when r.scored_peers < 3       then 'no_cohort'
    when not r.presence_known     then 'partial_window'
    when not r.in_cohort          then 'partial_window'
    when not r.sample_sufficient  then 'thin'
    when r.composite is null      then 'thin'
    when r.basis = 'complexity' and coalesce(r.sized_mr_pct, 0) < 60 then 'thin'
    else 'high'
  end,
  case
    when r.not_yet_present then
      'Start date ' || r.start_date || ' falls after this period — there is nothing here to score'
    when r.scored_peers < 3 then
      'Scored against ' || r.scored_peers || ' at this level with a full enough window — too few for a median to mean much'
    when not r.presence_known then
      'No start date on record, so how much of this period they were here cannot be established — scored on unadjusted totals and left out of the cohort median'
    when not r.in_cohort then
      'Present for ' || r.days_present || ' of ' || r.window_days
        || ' days in this period — their rates are scaled up to a full window, and they are left out of the cohort median so a partial window cannot move their peers'
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

  -- The raw facts, unchanged. These are what the person did; the prorated figures
  -- below are what the score was computed from, and both belong on the row.
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
  r.basis,

  r.start_date,
  r.window_days::int,
  r.days_present::int,
  case
    when r.days_present is null then null
    else round(100.0 * r.days_present / r.window_days, 1)
  end,
  r.in_cohort,
  r.scored_peers,
  r.tp_rate,
  r.iss_rate,
  r.rg_rate,
  r.rev_rate
from ranked r
where p_squad_id is null or r.squad_id = p_squad_id
order by r.composite desc nulls last, r.full_name;
$fn$;

comment on function engineer_outliers(timestamptz, timestamptz, uuid) is
  'Engineers scored 0-100 against their own seniority cohort, with rate inputs prorated by the days they were actually employed inside the window. Anyone below tenure_presence_floor() is scored and labelled but excluded from the cohort median and placed after the ranked set.';

-- --- regression: nothing moves for a full window ------------------------------
--
-- For an engineer whose start date precedes the window, `days_present` equals
-- `window_days`, `presence_fraction` is exactly 1, and every prorated input is
-- `v / 1` — the same numeric, not an approximation of it. Their sub-scores, their
-- composite and their rank are identical to 0023's, provided every peer in their
-- cohort is also full-window.
--
-- What *does* move, and must: a cohort that contained a below-floor row now has a
-- median computed without it, so every peer's relative score shifts. That is not a
-- regression, it is the second of the three fixes. On today's data it applies to
-- exactly one cohort — Senior Engineer, nine on paper, eight scored once Aleksa's
-- eleven days come out of the median.

-- --- the definition version ---------------------------------------------------
-- 0025 asks for this explicitly: bump `score_definition_version` in the same
-- migration that changes any scoring input, so a snapshot taken after today is
-- correctly marked incomparable with one taken before it. Without the bump, the
-- Senior cohort's shift would read as those eight engineers changing.

insert into app_settings (key, value)
values ('score_definition_version', '"0028-tenure-normalisation"'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- --- start_date, and who is allowed to set it ---------------------------------
--
-- All of the above rests on `engineers.start_date`, which arrives from HiBob's
-- `work.startDate` and is null whenever HiBob has no answer. Correcting it by hand
-- is now worth doing, because it moves a score — and a manual correction that the
-- next nightly sync silently reverts is worse than no correction at all, because
-- the reverting is invisible and the feature simply appears not to work.
--
-- So `start_date` gets the treatment `squad_source`, `seniority_source` and
-- `include_in_metrics_source` already have: a column recording where the value came
-- from, and a sync that will not overwrite 'manual'. The enforcement lives in
-- `src/lib/sync/hibob.ts` beside the three existing checks rather than in a trigger,
-- for the reason 0017 gives about `include_in_metrics`: the rule belongs where it
-- can be read and unit-tested next to the others it matches.
--
-- 'unknown' is the default rather than 'hibob', so a row nobody has ever synced or
-- edited does not claim a provenance it has not got.

alter table engineers
  add column if not exists start_date_source text not null default 'unknown'
    check (start_date_source in ('unknown', 'hibob', 'manual'));

comment on column engineers.start_date_source is
  'unknown = never established; hibob = written by the HiBob sync from work.startDate; manual = set in the admin screen and never overwritten by a sync. A manual row with a null start_date is a deliberate "we do not know", and is protected too.';

-- Every date currently here came from HiBob — nothing else has ever written this
-- column — so they are labelled as such rather than left claiming 'unknown'.
-- Restricted to rows carrying a hibob_id, because a hand-added engineer's row was
-- never touched by the sync. Idempotent: only 'unknown' rows are relabelled, so a
-- re-run cannot overwrite a manual correction made in between.
update engineers
set start_date_source = 'hibob'
where start_date_source = 'unknown'
  and start_date is not null
  and hibob_id is not null;

-- --- grants -------------------------------------------------------------------
-- 0021's posture, re-applied because `drop function` took the old grants with it:
-- anon executes nothing, even though these are security invoker and RLS would
-- return an unauthenticated caller nothing anyway. Production is publicly
-- reachable, so the grant and the policy are two independent locks.
--
-- `squad_outliers` is deliberately absent from this file. It is not redefined here
-- and its grants are not touched.

revoke all on function tenure_presence_floor()                            from public, anon;
revoke all on function engineer_outliers(timestamptz, timestamptz, uuid)  from public, anon;

grant execute on function tenure_presence_floor()                           to authenticated, service_role;
grant execute on function engineer_outliers(timestamptz, timestamptz, uuid) to authenticated, service_role;

