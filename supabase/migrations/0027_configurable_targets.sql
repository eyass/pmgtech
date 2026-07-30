-- =============================================================================
-- 0027_configurable_targets.sql — delivery targets as data, with an audit trail
-- =============================================================================
--
-- Thirteen numbers decide how a squad reads. Eleven of them were literals in
-- `src/lib/types/performance.ts` (TEAM_TARGETS, which colours every metric on the
-- team pages) and seven were literals again inside `squad_outliers` — six of those
-- the same numbers written twice, plus `mrs_per_engineer_week` (4/1) and
-- `reviews_per_engineer_week` (8/2), which exist nowhere else. Those last two are
-- the most arguable numbers in the system: they were set from this org's own spread
-- rather than from anything published, and 0021 says so in its own comment. Until
-- now, disagreeing with them needed a code deploy.
--
-- This file makes the thirteen editable, and makes an edit traceable. Seeded from
-- the current literals, so day one behaviour is byte-identical — the seed below is
-- the diff-able record of what the constants were.
--
-- Why a table and not `app_settings`
-- ----------------------------------
-- `app_settings` (0006) is `key -> jsonb`, and it is the right home for the things
-- already in it: allowed email domains, production environment name patterns, the
-- backfill window, the review-bot name patterns. Targets do not belong there, for
-- four reasons, in descending order of how much they matter:
--
--   1. **Read posture is the opposite.** 0006 deliberately gives `app_settings` no
--      select policy at all — it is service-role only, because it is operational
--      configuration and one of its keys gates who may read the product. Targets are
--      the opposite kind of thing: /outliers publishes them as the explanation of
--      every squad score ("60 is 0, 90 is 100"). Storing them in `app_settings`
--      would either leave them unreadable to `authenticated`, or force a select
--      policy onto a table that holds the viewer allow-list.
--   2. **The one invariant that matters cannot live in jsonb.** `good` must sit on
--      the correct side of `bad` for the metric's direction. Inverted, a target does
--      not error — it silently scores every squad backwards, and the page still
--      renders a confident number. As typed columns that is a CHECK constraint
--      (below) that no write path can get around. Inside a jsonb blob it is an
--      application-level convention that a direct `update app_settings` bypasses.
--   3. **The audit trail needs a per-metric row to point at.** A change is "who
--      moved `mrs_per_engineer_week` from 4 to 5, when". Against one jsonb key the
--      only recordable fact is that the blob changed.
--   4. **SQL has to read one metric cheaply.** `squad_outliers` wants
--      `score_vs_metric_target('mttr_hours', v)`, not a jsonb path expression into a
--      settings row, on every scored squad.
--
-- `direction` is stored but is not editable. Lower cycle time is better as a fact
-- about the metric, not a policy anyone should be able to flip from an admin
-- screen; what is editable is where `good` and `bad` sit, and the constraint uses
-- `direction` to keep those honest.

-- --- targets ------------------------------------------------------------------

create table if not exists metric_targets (
  metric_key text primary key,
  label      text not null,
  -- The value that scores 100, and the value that scores 0. Which is the larger of
  -- the two is decided by `direction`, and enforced below.
  good       numeric not null,
  bad        numeric not null,
  direction  text not null check (direction in ('higher-better', 'lower-better')),
  -- Set only for the seven metrics that feed the squad composite in
  -- `squad_outliers`. The other six colour a number on the team pages and are not
  -- scored, so they carry no dimension and no weight.
  score_dimension text check (score_dimension in ('throughput', 'flow', 'quality', 'collaboration')),
  score_weight    numeric check (score_weight > 0),
  -- Free text shown next to the target in the admin screen. This is where the
  -- reasoning for an arguable number lives, so the next person to disagree with it
  -- argues with a stated position rather than with a bare integer.
  rationale  text,
  sort_order int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by text,

  -- The guard this table exists for. A higher-better metric with good below bad
  -- would invert the whole 0-100 mapping in `score_vs_target` and produce a
  -- plausible-looking score that rewards exactly the wrong behaviour.
  constraint metric_targets_direction_agrees check (
    (direction = 'higher-better' and good > bad) or
    (direction = 'lower-better'  and good < bad)
  ),
  -- A scored metric needs a weight; an unscored one must not carry a stray weight
  -- that nothing reads.
  constraint metric_targets_weight_matches_dimension check (
    (score_dimension is null     and score_weight is null) or
    (score_dimension is not null and score_weight is not null)
  )
);

comment on table metric_targets is
  'Editable delivery targets: the good/bad thresholds every squad metric is scored and coloured against. Seeded from the constants previously hardcoded in src/lib/types/performance.ts and 0021_outliers.sql. Squads only — nothing here is ever applied to a person.';
comment on column metric_targets.good is 'The value that scores 100. Must be above bad for a higher-better metric and below it for a lower-better one.';
comment on column metric_targets.bad is 'The value that scores 0. Values beyond either end are clamped by score_vs_target.';
comment on column metric_targets.direction is 'Which way is better. A property of the metric, not a policy: not editable from the admin screen.';
comment on column metric_targets.score_dimension is 'Which squad_outliers dimension this metric feeds, or null if it only colours a team-page number.';
comment on column metric_targets.score_weight is 'Relative weight within that dimension. Null for unscored metrics.';

-- --- the seed: exactly the values that were in code ---------------------------
-- Eleven from TEAM_TARGETS, plus the two per-engineer rates that only ever existed
-- inside 0021's squad rubric. Six rows serve both: TEAM_TARGETS and the squad
-- rubric had them written twice with identical numbers, which is its own argument
-- for one row.
--
-- `on conflict do nothing` so re-running this migration never silently reverts a
-- target someone has since changed — the whole point of the table is that these
-- numbers move after deploy.

insert into metric_targets
  (metric_key, label, good, bad, direction, score_dimension, score_weight, sort_order, rationale)
values
  ('mrs_per_engineer_week', 'MRs per engineer per week', 4, 1, 'higher-better',
   'throughput', 2, 10,
   'Set from this org''s own spread (a median of 3.8 per engineer per week), not from anything published. One of the two most arguable numbers here.'),
  ('deploys_per_week', 'Production releases per week', 5, 1, 'higher-better',
   'throughput', 1, 20,
   'Loosely DORA: daily-or-better is elite, weekly-or-worse is low.'),
  ('median_cycle_hours', 'Cycle time (median hours)', 24, 120, 'lower-better',
   'flow', 1, 30,
   'Under a day is elite, a working week is low.'),
  ('change_failure_pct', 'Change failure rate', 15, 30, 'lower-better',
   'quality', 1, 40,
   'DORA''s 0-15% band is elite; above 30% a deploy is close to a coin toss.'),
  ('mttr_hours', 'Time to restore (hours)', 4, 24, 'lower-better',
   'quality', 1, 50,
   'Within half a working day is elite; a full day down is low.'),
  ('review_coverage_pct', 'Review coverage', 90, 60, 'higher-better',
   'collaboration', 1, 60,
   'Near-total coverage is the expectation; below 60% most changes ship unread.'),
  ('reviews_per_engineer_week', 'Reviews per engineer per week', 8, 2, 'higher-better',
   'collaboration', 1, 70,
   'Set from this org''s own spread (a median of 9.9 per engineer per week). The other of the two most arguable numbers. Only scored where headcount is 2 or more: over one person it is that person''s rate.'),
  ('flow_efficiency_pct', 'Flow efficiency', 40, 15, 'higher-better',
   null, null, 80,
   'Working time over elapsed time. Below 15% the squad spends most of its time waiting, which is a system problem rather than an effort one.'),
  ('median_review_response_hours', 'Review response time (median hours)', 4, 24, 'lower-better',
   null, null, 90,
   'Half a working day to first review keeps work moving; a day of waiting is where cycle time goes.'),
  ('review_gini', 'Review load Gini', 0.3, 0.6, 'lower-better',
   null, null, 100,
   'Runs 0 (evenly shared) to 1 (one person carries everything). Above roughly 0.6 the review load sits on one or two people, who are then a single point of failure.'),
  ('cross_squad_review_pct', 'Cross-squad reviews', 20, 5, 'higher-better',
   null, null, 110,
   'Some review across squad boundaries is how knowledge crosses them. Near zero means each squad is sealed.'),
  ('sprint_completion_pct', 'Sprint completion', 80, 50, 'higher-better',
   null, null, 120,
   'Context rather than a target to manage: completion is trivially gamed by committing to less.'),
  ('unplanned_work_pct', 'Unplanned work', 20, 40, 'lower-better',
   null, null, 130,
   'Above 40% of the sprint arriving unplanned, a plan is not a plan.')
on conflict (metric_key) do nothing;

-- --- audit trail --------------------------------------------------------------
-- A squad's score moving is ambiguous on its own: the squad may have changed, or
-- the yardstick may have. This table is what tells those two apart, so it records
-- the before as well as the after — a row saying "good is now 6" cannot answer the
-- question, and a row saying "good went 4 -> 6 on the 3rd" can.

create table if not exists metric_target_changes (
  id         uuid primary key default extensions.gen_random_uuid(),
  -- `restrict` rather than `cascade` on purpose: deleting a target should not be able
  -- to take its history with it. If a metric is genuinely retired, its trail has to be
  -- removed deliberately and separately, which is the right amount of friction for the
  -- table whose whole job is to survive.
  metric_key text not null references metric_targets(metric_key) on update cascade on delete restrict,
  changed_by text not null,
  changed_at timestamptz not null default now(),
  old_good   numeric not null,
  old_bad    numeric not null,
  new_good   numeric not null,
  new_bad    numeric not null,
  old_weight numeric,
  new_weight numeric,
  -- Cached so the history reads without joining back to a row that may have moved
  -- again since, and so "stricter or looser" can be worked out at read time without
  -- knowing the metric's direction from elsewhere.
  direction  text not null,
  note       text
);

comment on table metric_target_changes is
  'Every edit to a delivery target: who, when, and from what to what. The point is attribution — a squad score that drops the day after a target got stricter is explained by this table rather than by the squad.';

create index if not exists metric_target_changes_metric_idx
  on metric_target_changes (metric_key, changed_at desc);
create index if not exists metric_target_changes_when_idx
  on metric_target_changes (changed_at desc);

-- --- audit trigger ------------------------------------------------------------
-- On the table rather than inside the writing function, so the trail cannot be
-- bypassed: a psql `update metric_targets` during an incident is audited exactly
-- like an admin-screen edit. The actor arrives through a transaction-local setting
-- because a service-role REST connection has no useful `current_user`; a direct SQL
-- edit that sets nothing is recorded as 'unknown', which is honest and still dated.

create or replace function log_metric_target_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if (old.good, old.bad, old.score_weight) is not distinct from (new.good, new.bad, new.score_weight) then
    return new;
  end if;

  insert into metric_target_changes (
    metric_key, changed_by, direction,
    old_good, old_bad, new_good, new_bad, old_weight, new_weight, note
  )
  values (
    new.metric_key,
    coalesce(nullif(current_setting('pmgtech.actor', true), ''), 'unknown'),
    new.direction,
    old.good, old.bad, new.good, new.bad, old.score_weight, new.score_weight,
    nullif(current_setting('pmgtech.change_note', true), '')
  );

  new.updated_at := now();
  new.updated_by := coalesce(nullif(current_setting('pmgtech.actor', true), ''), new.updated_by);
  return new;
end
$$;

drop trigger if exists metric_targets_audit on metric_targets;
create trigger metric_targets_audit
  before update on metric_targets
  for each row execute function log_metric_target_change();

-- --- the write path -----------------------------------------------------------
-- One function, so validation, the actor and the audit row are a single
-- transaction. `direction` is not a parameter: it is not editable, and the CHECK
-- constraint uses it to reject an inverted pair. The explicit checks below exist
-- only to turn that constraint violation into a sentence an admin screen can print.

create or replace function set_metric_target(
  p_metric_key text,
  p_good       numeric,
  p_bad        numeric,
  p_weight     numeric default null,
  p_actor      text default null,
  p_note       text default null
)
returns metric_targets
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  before_row metric_targets;
  after_row  metric_targets;
begin
  select * into before_row from metric_targets where metric_key = p_metric_key;
  if not found then
    raise exception 'Unknown metric target: %', p_metric_key;
  end if;
  if p_good is null or p_bad is null then
    raise exception 'Both good and bad are required for %', p_metric_key;
  end if;
  if p_good = p_bad then
    raise exception
      'good and bad cannot be equal for % — score_vs_target has no range to map onto and would withhold the metric for every squad',
      p_metric_key;
  end if;
  if before_row.direction = 'higher-better' and p_good <= p_bad then
    raise exception
      '% is higher-better, so good (%) must be above bad (%) — inverted, every squad would be scored backwards',
      p_metric_key, p_good, p_bad;
  end if;
  if before_row.direction = 'lower-better' and p_good >= p_bad then
    raise exception
      '% is lower-better, so good (%) must be below bad (%) — inverted, every squad would be scored backwards',
      p_metric_key, p_good, p_bad;
  end if;
  if before_row.score_dimension is null and p_weight is not null then
    raise exception '% is not part of the squad score, so it has no weight', p_metric_key;
  end if;
  if before_row.score_dimension is not null and coalesce(p_weight, before_row.score_weight) <= 0 then
    raise exception 'Weight for % must be above zero', p_metric_key;
  end if;

  perform set_config('pmgtech.actor', coalesce(nullif(btrim(p_actor), ''), 'unknown'), true);
  perform set_config('pmgtech.change_note', coalesce(nullif(btrim(p_note), ''), ''), true);

  update metric_targets
     set good = p_good,
         bad  = p_bad,
         score_weight = case
           when score_dimension is null then null
           else coalesce(p_weight, score_weight)
         end
   where metric_key = p_metric_key
  returning * into after_row;

  return after_row;
end
$$;

comment on function set_metric_target(text, numeric, numeric, numeric, text, text) is
  'Move a delivery target, validating direction and recording who moved it. The only supported write path; direction itself is not editable.';

-- --- reading targets from SQL -------------------------------------------------
-- What `squad_outliers` needs. `score_vs_target(v, good, bad)` from 0021 stays
-- exactly as it is — it is the arithmetic, and it is immutable. This wraps it with a
-- lookup, so a scoring function names a metric instead of restating its thresholds.
--
-- A missing key returns null, and null is the safe answer here rather than a
-- fallback number: 0021's composite drops a null dimension and renormalises the
-- remaining weights, so an absent target withholds that input instead of scoring it
-- zero. A zero would be indistinguishable from a squad that genuinely missed the
-- target, which is the one outcome this must never produce. The rows are seeded and
-- nothing deletes them, so the null path is a guard rather than a mode.

create or replace function score_vs_metric_target(p_metric_key text, v numeric)
returns numeric
language sql
stable
set search_path = public, extensions
as $$
  select score_vs_target(v, t.good, t.bad)
  from metric_targets t
  where t.metric_key = p_metric_key
$$;

comment on function score_vs_metric_target(text, numeric) is
  'Value scored 0-100 against the stored target for a metric. Null when the metric has no target row, so a missing target withholds the input rather than scoring it zero.';

create or replace function metric_target_weight(p_metric_key text, p_default numeric default 1)
returns numeric
language sql
stable
set search_path = public, extensions
as $$
  select coalesce(
    (select t.score_weight from metric_targets t where t.metric_key = p_metric_key),
    p_default
  )
$$;

comment on function metric_target_weight(text, numeric) is
  'Stored weight for a scored metric, falling back to the supplied default when there is no target row.';

-- --- RLS and grants ----------------------------------------------------------
-- 0021's posture, applied to tables: RLS on, anon holds nothing, `authenticated`
-- reads through the viewer predicate, and only the service role writes. Production
-- is publicly reachable, so an anon grant on an admin-writable table would be a
-- live hole; and unlike `app_settings` these rows are readable, because the product
-- already publishes them as the explanation of every squad score.
--
-- No insert/update/delete policy is defined, so RLS refuses writes from
-- `authenticated` outright. Writes arrive through the service-role client in the
-- admin server actions, which bypasses RLS and is re-checked by requireAdmin().

alter table metric_targets        enable row level security;
alter table metric_target_changes enable row level security;

drop policy if exists metric_targets_viewer_select on metric_targets;
create policy metric_targets_viewer_select on metric_targets
  for select to authenticated using (is_app_viewer());

drop policy if exists metric_target_changes_viewer_select on metric_target_changes;
create policy metric_target_changes_viewer_select on metric_target_changes
  for select to authenticated using (is_app_viewer());

revoke all on table metric_targets        from public, anon;
revoke all on table metric_target_changes from public, anon;

grant select on table metric_targets        to authenticated;
grant select on table metric_target_changes to authenticated;
grant select, insert, update, delete on table metric_targets        to service_role;
grant select, insert, update, delete on table metric_target_changes to service_role;

revoke all on function log_metric_target_change()                                     from public, anon, authenticated;
revoke all on function set_metric_target(text, numeric, numeric, numeric, text, text)  from public, anon, authenticated;
revoke all on function score_vs_metric_target(text, numeric)                          from public, anon;
revoke all on function metric_target_weight(text, numeric)                            from public, anon;

grant execute on function set_metric_target(text, numeric, numeric, numeric, text, text) to service_role;
grant execute on function score_vs_metric_target(text, numeric) to authenticated, service_role;
grant execute on function metric_target_weight(text, numeric)   to authenticated, service_role;

-- --- what 0026 has to do to consume these ------------------------------------
-- `squad_outliers` is being redefined in 0026 by another change, so it is not
-- touched here. When it lands, the seven literals in its `scored` CTE become
-- lookups. Each of these is the same number as before, read from a row:
--
--   score_vs_target(<throughput rate>, 4, 1)        -> score_vs_metric_target('mrs_per_engineer_week',     <throughput rate>)
--   score_vs_target(b.deploys_per_week, 5, 1)       -> score_vs_metric_target('deploys_per_week',          b.deploys_per_week)
--   score_vs_target(b.median_cycle_hours, 24, 120)  -> score_vs_metric_target('median_cycle_hours',        b.median_cycle_hours)
--   score_vs_target(b.change_failure_pct, 15, 30)   -> score_vs_metric_target('change_failure_pct',        b.change_failure_pct)
--   score_vs_target(b.mttr_hours, 4, 24)            -> score_vs_metric_target('mttr_hours',                b.mttr_hours)
--   score_vs_target(b.review_coverage_pct, 90, 60)  -> score_vs_metric_target('review_coverage_pct',       b.review_coverage_pct)
--   score_vs_target(b.reviews_per_engineer_week,8,2)-> score_vs_metric_target('reviews_per_engineer_week', b.reviews_per_engineer_week)
--
-- and the two weight arrays that are not all 1s become
--
--   array[metric_target_weight('mrs_per_engineer_week', 2), metric_target_weight('deploys_per_week', 1)]
--   array[metric_target_weight('review_coverage_pct', 1),   metric_target_weight('reviews_per_engineer_week', 1)]
--
-- Three things travel with that change:
--   * `squad_outliers` must stay `stable` and never be declared `immutable` — these
--     lookups read a table. It is already `stable`, so nothing needs editing today;
--     it is a constraint on future edits to the file.
--   * The `headcount >= 2` guard on `reviews_per_engineer_week` stays where it is.
--     It is a statement about what a per-engineer rate means over one person, not a
--     threshold, so it does not belong in the table.
--   * Nothing else moves: `score_vs_target` keeps its signature and its other
--     callers, and the engineer path scores against `score_vs_cohort` and has no
--     absolute targets to read.
