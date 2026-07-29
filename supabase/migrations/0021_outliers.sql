-- =============================================================================
-- 0021_outliers.sql — scored rankings for engineers and squads
-- =============================================================================
--
-- A composite score, and a ranking off the back of it, at both altitudes. This is
-- a deliberate reversal of the earlier position in docs/measurement-framework.md,
-- which refused an individual composite; the doc has been updated rather than left
-- to contradict this file. What that position was protecting against is real, so
-- the score is built to keep as much of the protection as a single number can:
--
--   * Engineers are scored against their own seniority cohort, never against the
--     org. A junior is measured against juniors. 50 means "at the median for your
--     level", not "half marks".
--   * Squads are scored against absolute targets rather than each other, so a
--     good squad in a good org does not lose points for its colleagues, and the
--     bottom squad is only bottom if it is actually missing the targets.
--   * Every sub-score and every input is returned alongside the composite, so a
--     ranking can always be taken apart. A score nobody can audit is a rumour.
--   * Weights are equal across the four dimensions, and stated. There is no
--     defensible reason to weight flow above collaboration, so nothing pretends
--     there is.
--   * Thin data still gets a score, because withholding one was the old design,
--     but it is labelled: `score_confidence` says whether the number rests on
--     enough work and a big enough cohort to mean anything. Two merged merge
--     requests produce a score and a warning, not a silent placing.
--
-- The band tally from 0018 is kept beside the score. It answers a different
-- question — how many dimensions are *materially* apart from the cohort, with the
-- 25%/10-point gates applied — and it is the honest check on the score's
-- precision: a score of 47 against 53 is noise, and the tally will say so by
-- reading zero on both sides.

-- --- scoring helpers ----------------------------------------------------------

-- Absolute: map a value onto 0-100 between a 'bad' and a 'good' threshold. Works
-- in both directions without a flag, because lower-better metrics simply have
-- good < bad, and clamps outside the range so a spectacular value cannot buy
-- back points lost elsewhere.
create or replace function score_vs_target(v numeric, good numeric, bad numeric)
returns numeric
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when v is null or good = bad then null
    else greatest(0, least(100, round(100.0 * (v - bad) / (good - bad))))
  end
$$;

-- Relative: map a value onto 0-100 by how far it sits from its cohort median,
-- scaled by the cohort's own spread. 50 is the median; ±1 interquartile range is
-- ±15 points, which is the same shape as an IQ scale and for the same reason —
-- the unit has to come from the distribution, because hours, percentages and
-- review counts have no common one.
--
-- The spread floor matters. With a cohort of five the IQR can be zero while the
-- values differ, and dividing by it would send everyone to 0 or 100. Where there
-- is genuinely no spread at all the function says so bluntly: equal to the median
-- is 50, anything else is the extreme, because a distribution with no width
-- cannot support a middle answer.
create or replace function score_vs_cohort(
  v numeric, med numeric, q1 numeric, q3 numeric, higher_better boolean
)
returns numeric
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when v is null or med is null then null
    when greatest(q3 - q1, 0.15 * abs(med)) = 0 then
      case
        when v = med then 50
        when (v > med) = higher_better then 100
        else 0
      end
    else greatest(0, least(100, round(
      50 + 15 * (case when higher_better then 1 else -1 end)
         * (v - med) / greatest(q3 - q1, 0.15 * abs(med))
    )))
  end
$$;

comment on function score_vs_target(numeric, numeric, numeric) is
  'Value scored 0-100 between a bad and a good threshold; direction is implied by good < bad or good > bad.';
comment on function score_vs_cohort(numeric, numeric, numeric, numeric, boolean) is
  'Value scored 0-100 against a cohort median, one interquartile range being 15 points. 50 is the median.';

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
  -- the score, its parts, and how much it can be trusted
  score              numeric,
  rank_in_org        int,
  rank_at_level      int,
  score_confidence   text,
  confidence_reason  text,
  throughput_score   numeric,
  flow_score         numeric,
  quality_score      numeric,
  collaboration_score numeric,
  -- the materiality tally from 0018, as the check on the score's precision
  signals_above      int,
  signals_below      int,
  signals_read       int,
  net                int,
  standing           text,
  flow_band          text,
  quality_band       text,
  collaboration_band text,
  shape              text,
  -- the inputs, so a score can be taken apart
  merged_mrs         int,
  issues_resolved    int,
  reviews_given      int,
  distinct_authors_reviewed int,
  median_cycle_hours numeric,
  review_coverage_received_pct numeric,
  large_mr_pct       numeric,
  reverts_authored   int,
  last_active_at     timestamptz
)
language sql
stable
set search_path = public, extensions
as $fn$
with p as (
  -- Never filtered by squad here: the cohort is the engineer's level across the
  -- whole org, and narrowing the input would re-baseline everyone against their
  -- own team, which is not what a level cohort means.
  select * from engineer_profiles(p_from, p_to, null, null)
),
coh as (
  select
    seniority_key,
    (percentile_cont(0.5) within group (order by merged_mrs))::numeric                  as med_mrs,
    (percentile_cont(0.25) within group (order by merged_mrs))::numeric                  as q1_mrs,
    (percentile_cont(0.75) within group (order by merged_mrs))::numeric                  as q3_mrs,
    (percentile_cont(0.5) within group (order by issues_resolved))::numeric             as med_iss,
    (percentile_cont(0.25) within group (order by issues_resolved))::numeric             as q1_iss,
    (percentile_cont(0.75) within group (order by issues_resolved))::numeric             as q3_iss,
    (percentile_cont(0.5) within group (order by median_cycle_hours))::numeric          as med_cycle,
    (percentile_cont(0.25) within group (order by median_cycle_hours))::numeric          as q1_cycle,
    (percentile_cont(0.75) within group (order by median_cycle_hours))::numeric          as q3_cycle,
    (percentile_cont(0.5) within group (order by review_coverage_received_pct))::numeric as med_cov,
    (percentile_cont(0.25) within group (order by review_coverage_received_pct))::numeric as q1_cov,
    (percentile_cont(0.75) within group (order by review_coverage_received_pct))::numeric as q3_cov,
    (percentile_cont(0.5) within group (order by large_mr_pct))::numeric                as med_large,
    (percentile_cont(0.25) within group (order by large_mr_pct))::numeric                as q1_large,
    (percentile_cont(0.75) within group (order by large_mr_pct))::numeric                as q3_large,
    (percentile_cont(0.5) within group (order by reverts_authored))::numeric            as med_rev,
    (percentile_cont(0.25) within group (order by reverts_authored))::numeric            as q1_rev,
    (percentile_cont(0.75) within group (order by reverts_authored))::numeric            as q3_rev,
    (percentile_cont(0.5) within group (order by reviews_given))::numeric               as med_rg,
    (percentile_cont(0.25) within group (order by reviews_given))::numeric               as q1_rg,
    (percentile_cont(0.75) within group (order by reviews_given))::numeric               as q3_rg,
    (percentile_cont(0.5) within group (order by distinct_authors_reviewed))::numeric   as med_da,
    (percentile_cont(0.25) within group (order by distinct_authors_reviewed))::numeric   as q1_da,
    (percentile_cont(0.75) within group (order by distinct_authors_reviewed))::numeric   as q3_da
  from p
  group by seniority_key
),
scored as (
  select
    p.*,
    -- Within a dimension the weights say which input carries it: merge requests
    -- over issues because issue hygiene varies by squad, review coverage over
    -- MR size and reverts because it is the one an engineer least controls alone,
    -- reviews given over people reviewed for because breadth without volume is
    -- easy to game and volume without breadth is not.
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_cohort(p.merged_mrs,      c.med_mrs,  c.q1_mrs,  c.q3_mrs,  true),
           score_vs_cohort(p.issues_resolved, c.med_iss,  c.q1_iss,  c.q3_iss,  true)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_throughput,

    score_vs_cohort(p.median_cycle_hours, c.med_cycle, c.q1_cycle, c.q3_cycle, false)
                                                                          as s_flow,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1, 1]::numeric[],
         array[
           score_vs_cohort(p.review_coverage_received_pct, c.med_cov,  c.q1_cov,  c.q3_cov,  true),
           score_vs_cohort(p.large_mr_pct,                 c.med_large, c.q1_large, c.q3_large, false),
           score_vs_cohort(p.reverts_authored,             c.med_rev,  c.q1_rev,  c.q3_rev,  false)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_quality,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_cohort(p.reviews_given,             c.med_rg, c.q1_rg, c.q3_rg, true),
           score_vs_cohort(p.distinct_authors_reviewed, c.med_da, c.q1_da, c.q3_da, true)
         ]
       ) as t(w, v)
      where v is not null)                                                as s_collaboration,

    (  (p.flow_band          = 'above')::int
     + (p.quality_band       = 'above')::int
     + (p.collaboration_band = 'above')::int)                             as above,
    (  (p.flow_band          = 'below')::int
     + (p.quality_band       = 'below')::int
     + (p.collaboration_band = 'below')::int)                             as below,
    (  (p.flow_band          <> 'insufficient')::int
     + (p.quality_band       <> 'insufficient')::int
     + (p.collaboration_band <> 'insufficient')::int)                     as read_count
  from p
  join coh c on c.seniority_key = p.seniority_key
),
composed as (
  select
    s.*,
    -- Equal weights across the four dimensions. A dimension with no data drops
    -- out and the rest are renormalised, so a missing input never reads as a zero.
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
    rank() over (order by c.composite desc nulls last)                             as org_rank,
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

  -- The score is always produced. What varies is whether it should be acted on,
  -- and that is said out loud rather than left for the reader to work out from a
  -- merge request count in another column.
  case
    when r.peers_at_level < 3    then 'no_cohort'
    when not r.sample_sufficient then 'thin'
    when r.composite is null     then 'thin'
    else 'high'
  end,
  case
    when r.peers_at_level < 3 then
      'Scored against ' || r.peers_at_level || ' at this level — too few for a median to mean much'
    when not r.sample_sufficient then
      'Fewer than 5 merged merge requests and fewer than 5 resolved issues in this period'
    when r.composite is null then
      'No dimension had any data behind it'
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
  r.last_active_at
from ranked r
-- Filtered after ranking on purpose: a squad view shows where its people sit in
-- the org, not a re-ranking that makes someone first in a team of three.
where p_squad_id is null or r.squad_id = p_squad_id
order by r.composite desc nulls last, r.full_name;
$fn$;

comment on function engineer_outliers(timestamptz, timestamptz, uuid) is
  'Engineers scored 0-100 against their own seniority cohort across four equally weighted dimensions, with sub-scores, inputs, ranks and a confidence flag. 50 is the cohort median.';

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
  -- inputs, each with the target it was scored against
  mrs_per_engineer_week    numeric,
  deploys_per_week         numeric,
  median_cycle_hours       numeric,
  change_failure_pct       numeric,
  mttr_hours               numeric,
  review_coverage_pct      numeric,
  reviews_per_engineer_week numeric,
  -- sample sizes behind the medians, so a thin score is visible as thin
  cycle_sample  int,
  deploy_sample int,
  mttr_sample   int
)
language sql
stable
set search_path = public, extensions
as $fn$
with s as (
  select * from squad_scorecards(p_from, p_to)
),
-- A placeholder squad with nobody in it and nothing merged is not the bottom of
-- the table, it is an empty row. Three of the eight squads here are exactly that.
live as (
  select * from s where headcount > 0 or merged_mrs > 0
),
scored as (
  select
    l.*,
    -- Absolute targets, not a comparison between squads. Six of these thresholds
    -- are the ones already documented for team health; the two per-engineer rates
    -- are new here, set from this org's own spread (a median of 3.8 merge requests
    -- and 9.9 reviews per engineer per week) rather than from anything published.
    -- They are the two most arguable numbers in this file and the easiest to change:
    -- they live here and nowhere else.
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[2, 1]::numeric[],
         array[
           score_vs_target(l.mrs_per_engineer_week, 4, 1),
           score_vs_target(l.deploys_per_week,      5, 1)
         ]
       ) as t(w, v)
      where v is not null)                                              as s_throughput,

    score_vs_target(l.median_cycle_hours, 24, 120)                      as s_flow,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[1, 1]::numeric[],
         array[
           score_vs_target(l.change_failure_pct, 15, 30),
           score_vs_target(l.mttr_hours,          4, 24)
         ]
       ) as t(w, v)
      where v is not null)                                              as s_quality,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[1, 1]::numeric[],
         array[
           score_vs_target(l.review_coverage_pct, 90, 60),
           -- Only where a per-engineer rate means anything: over one person it is
           -- that person's rate, and scoring a squad of one on it is scoring them.
           case when l.headcount >= 2
                then score_vs_target(l.reviews_per_engineer_week, 8, 2) end
         ]
       ) as t(w, v)
      where v is not null)                                              as s_collaboration
  from live l
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
    when c.composite is null                        then 'thin'
    when c.headcount < 2                            then 'thin'
    when c.cycle_sample < 20 and c.deploy_sample < 20 then 'thin'
    else 'high'
  end,
  case
    when c.composite is null then 'Nothing measurable landed for this squad in the period'
    when c.headcount < 2 then
      'One person in metrics, so the per-engineer rates are an individual''s rates'
    when c.cycle_sample < 20 and c.deploy_sample < 20 then
      'Fewer than 20 merge requests and fewer than 20 production releases behind the medians'
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
  c.mttr_sample
from composed c
order by c.composite desc nulls last, c.squad_name;
$fn$;

comment on function squad_outliers(timestamptz, timestamptz) is
  'Squads scored 0-100 against absolute targets across four equally weighted dimensions, with sub-scores, inputs and a confidence flag. Empty placeholder squads are excluded.';

-- --- grants -------------------------------------------------------------------
-- 0008's posture: anon executes nothing, even though these are security invoker
-- and RLS would return an unauthenticated caller nothing anyway.

revoke all on function score_vs_target(numeric, numeric, numeric)                from public, anon;
revoke all on function score_vs_cohort(numeric, numeric, numeric, numeric, boolean) from public, anon;
revoke all on function engineer_outliers(timestamptz, timestamptz, uuid)          from public, anon;
revoke all on function squad_outliers(timestamptz, timestamptz)                   from public, anon;

grant execute on function score_vs_target(numeric, numeric, numeric)                to authenticated, service_role;
grant execute on function score_vs_cohort(numeric, numeric, numeric, numeric, boolean) to authenticated, service_role;
grant execute on function engineer_outliers(timestamptz, timestamptz, uuid)          to authenticated, service_role;
grant execute on function squad_outliers(timestamptz, timestamptz)                   to authenticated, service_role;
