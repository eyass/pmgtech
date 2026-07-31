-- =============================================================================
-- 0026_targets_from_table.sql — squad_outliers reads its thresholds, stops holding them
-- =============================================================================
--
-- 0027 makes the thirteen delivery targets editable and gives them an audit trail.
-- On its own that ships an admin control that does not control anything: the seven
-- thresholds the squad composite is actually built from were literals inside
-- `squad_outliers`, so moving a row in `metric_targets` would move the colour of a
-- number on the team pages and leave every squad score exactly where it was. The
-- confirmation dialog on that screen promises "every squad's score moves". This
-- file is what makes the promise true, which is why 0027 is not applied without it.
--
-- What changes: the seven `score_vs_target(v, <good>, <bad>)` calls in the `scored`
-- CTE become `score_vs_metric_target('<metric_key>', v)`, and the two weight arrays
-- that 0027 seeds a weight for become `metric_target_weight(...)` lookups. Nothing
-- else about the function moves — same signature, same return columns, same
-- ordering, same confidence rules, same complexity basis. The whole point is that
-- the scores do not change on the day this lands: 0027 seeds the table with exactly
-- the numbers that were compiled in here, so this is a substitution and not a
-- re-scoring. The re-scoring is whatever an admin does afterwards, deliberately.
--
-- Four things this had to be careful about
-- ----------------------------------------
--   1. **Still `stable`, never `immutable`.** The thresholds now come from a table,
--      so the function is no longer a pure arithmetic expression over its
--      arguments. It was already `stable` and stays `stable` — which is what lets
--      Postgres cache it within a statement, and is exactly the guarantee that
--      `immutable` would be a lie about from here on.
--   2. **The `headcount >= 2` guard stays in SQL.** It is not a threshold. It says
--      that "reviews per engineer per week" over one person is that person's own
--      rate, and scoring a squad of one on it is scoring an individual — a
--      statement about what the metric means, not a number anyone should be able to
--      edit from an admin screen. So it does not belong in `metric_targets`.
--   3. **A missing target key withholds the input rather than zeroing it.**
--      `score_vs_metric_target` returns null when there is no row, and 0021's
--      dimension and composite averages already drop a null term and renormalise
--      the remaining weights. So a target that is somehow absent costs a squad
--      nothing. The alternative — a fallback number, or a zero — would be
--      indistinguishable from a squad that genuinely missed the target, and would
--      make a configuration gap read as a performance problem.
--      `metric_target_weight` does take a default, because a weight only decides
--      how two present inputs trade off against each other; the defaults passed
--      below are the weights that were hardcoded here, so an absent row leaves the
--      arithmetic exactly as it was.
--   4. **Grants are re-stated, because the drop below clears them.** `drop
--      function` takes the ACL with it, so 0023's revoke/grant block is repeated
--      verbatim at the foot of this file. Skipping it would leave `squad_outliers`
--      on Postgres's default of "execute to PUBLIC", which on a publicly reachable
--      deployment hands the whole squad ranking to `anon`.
--
-- Ordering note: forward references
-- ---------------------------------
-- This file is numbered before 0027 and depends on two functions 0027 creates, so
-- on a clean replay the body below refers to functions that do not exist yet.
-- `check_function_bodies` is turned off for the duration for that reason and reset
-- at the end — the same mechanism pg_dump relies on to restore functions without
-- worrying about the order they were written in. The consequence to know about:
-- between this migration and 0027, `squad_outliers` will not execute, because the
-- lookups it now makes have nothing to resolve to. The two belong together and
-- have to be applied together; neither is useful alone.

set check_function_bodies = off;

-- --- squads -------------------------------------------------------------------
-- Reproduced from 0023 with the seven thresholds and two weight arrays replaced.
-- Everything else here is 0023's text.

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
    -- the stored mrs_per_engineer_week target keeps meaning exactly what it meant.
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
    -- Thresholds and weights now come from metric_targets. The defaults passed to
    -- metric_target_weight are the weights that used to be written here, so a
    -- missing row leaves the trade-off between the two inputs unchanged.
    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[
           metric_target_weight('mrs_per_engineer_week', 2),
           metric_target_weight('deploys_per_week', 1)
         ],
         array[
           score_vs_metric_target(
             'mrs_per_engineer_week',
             case when b.basis = 'complexity' then b.eff_rate else b.mrs_per_engineer_week end),
           score_vs_metric_target('deploys_per_week', b.deploys_per_week)
         ]
       ) as t(w, v)
      where v is not null)                                              as s_throughput,

    score_vs_metric_target('median_cycle_hours', b.median_cycle_hours)  as s_flow,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[1, 1]::numeric[],
         array[
           score_vs_metric_target('change_failure_pct', b.change_failure_pct),
           score_vs_metric_target('mttr_hours',         b.mttr_hours)
         ]
       ) as t(w, v)
      where v is not null)                                              as s_quality,

    (select round(sum(w * v) / nullif(sum(w), 0), 1)
       from unnest(
         array[
           metric_target_weight('review_coverage_pct', 1),
           metric_target_weight('reviews_per_engineer_week', 1)
         ],
         array[
           score_vs_metric_target('review_coverage_pct', b.review_coverage_pct),
           -- Only where a per-engineer rate means anything: over one person it is
           -- that person's rate, and scoring a squad of one on it is scoring them.
           -- A statement about the metric, not a threshold, so it stays in SQL.
           case when b.headcount >= 2
                then score_vs_metric_target('reviews_per_engineer_week', b.reviews_per_engineer_week) end
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
  'Squads scored 0-100 against the editable targets in metric_targets. Throughput uses complexity-weighted merge requests per engineer per week once the org has measured 60% of them, keeping the same unit and target as the raw rate. A metric with no target row is withheld from its dimension rather than scored zero.';

-- --- grants -------------------------------------------------------------------
-- 0021's posture, restated because the drop above cleared the ACL: anon executes
-- nothing, even though this is security invoker and RLS would return an
-- unauthenticated caller nothing anyway. Production is publicly reachable, so
-- leaving Postgres's default execute-to-PUBLIC in place would publish the ranking.
-- engineer_outliers is untouched by this migration and keeps the grants it has.

revoke all on function squad_outliers(timestamptz, timestamptz) from public, anon;

grant execute on function squad_outliers(timestamptz, timestamptz) to authenticated, service_role;

reset check_function_bodies;
