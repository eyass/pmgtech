-- =============================================================================
-- 0025_score_snapshots.sql — keep what a score *was*
-- =============================================================================
--
-- Every score in this app is recomputed from a date range at request time.
-- `engineer_outliers(from, to)` and `squad_outliers(from, to)` read the current
-- tables through the current formula, which has two consequences nobody chose:
--
--   1. **There is no trend.** The dashboard can say who is first today and cannot
--      say whether they were first last month.
--   2. **Changing the definition silently rewrites the past.** This has already
--      happened twice: 0023 moved throughput from counting merge requests to
--      counting complexity-weighted ones, and 0024 changed the churn that weight
--      is built from. Both times every historical score changed and nothing
--      recorded that it had.
--
-- So the scores get written down: two tables, one per altitude, holding the
-- composite, every sub-score, and the confidence and standing fields — because a
-- snapshot that drops the caveats reads as more solid than it was.
--
-- The column that makes this honest rather than merely persistent is
-- **`definition_version`**, stamped from `app_settings.score_definition_version`.
-- A delta across a version boundary is not a delta; it is two different questions
-- answered once each. Bump that setting in the same migration that changes any
-- scoring input, and every later snapshot is correctly labelled incomparable with
-- everything before it.
--
-- There is deliberately **no backfill**. The formula that produced June's score no
-- longer exists in the database, and running today's formula over June's window
-- would manufacture exactly the false continuity `definition_version` prevents.
-- History starts the first time the capture runs.
--
-- -----------------------------------------------------------------------------
-- Provenance note, recorded because it matters for trusting this file:
--
-- This migration was applied to the `pmgtech` project before the commit that
-- authored it survived. The authoring work was lost with its worktree, and this
-- file was reconstructed from the exact SQL that was applied — verified against
-- the live database afterwards: both tables present, RLS enabled on both, `anon`
-- holding no grant, `score_definition_version()` returning '0024-authored-churn',
-- and `capture_score_snapshots` writing 14 engineer and 6 squad rows and staying
-- idempotent on a second run. The schema in this file is what the database has.
--
-- What did NOT survive, and is therefore NOT in this repo: the `/api/snapshots`
-- route, its Vercel cron entry, the `src/proxy.ts` change that keeps the cron from
-- being redirected to /login, the sparkline on `/outliers`, and the bump chart and
-- movers components. **Nothing currently calls `capture_score_snapshots`**, so
-- after the single seeded capture below, history stops accumulating until that code
-- is rebuilt. The tables are not orphaned — they are waiting.
-- =============================================================================

insert into app_settings (key, value) values
  ('score_definition_version', '"0024-authored-churn"'::jsonb)
on conflict (key) do nothing;

comment on table app_settings is
  'Runtime configuration. score_definition_version stamps every score snapshot, so scores computed under different formulas are never compared.';

-- security definer for the same reason as `is_app_viewer()` in 0006: app_settings
-- is readable by the service role only, and this must be callable from a function a
-- signed-in admin may invoke.
create or replace function score_definition_version()
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    (select value #>> '{}' from app_settings where key = 'score_definition_version'),
    'unversioned'
  )
$$;

comment on function score_definition_version() is
  'The formula version stamped onto score snapshots. Falls back to ''unversioned'' rather than null, so a row can never be silently comparable with everything.';

-- --- engineers ----------------------------------------------------------------

create table if not exists engineer_score_snapshots (
  id                 uuid primary key default extensions.gen_random_uuid(),
  engineer_id        uuid not null references engineers(id) on delete cascade,
  -- Which window was measured. A '7d' score and a '90d' score are different
  -- measurements of the same person and must never land in one series.
  period_key         text not null,
  -- The day the window ended, not the day the row was written. That is what makes
  -- the upsert below idempotent; `captured_at` records when the writing happened.
  captured_for       date not null,
  definition_version text not null,

  score              numeric,
  throughput_score   numeric,
  flow_score         numeric,
  quality_score      numeric,
  collaboration_score numeric,

  rank_in_org        int,
  rank_at_level      int,
  peers_at_level     int,
  seniority_key      text,
  squad_id           uuid,

  -- How much the score can carry. Stored with it rather than recomputed later.
  score_confidence   text,
  confidence_reason  text,
  signals_above      int,
  signals_below      int,
  signals_read       int,
  net                int,
  standing           text,
  throughput_basis   text,

  window_from        timestamptz not null,
  window_to          timestamptz not null,
  captured_at        timestamptz not null default now(),

  unique (engineer_id, period_key, captured_for)
);

comment on column engineer_score_snapshots.definition_version is
  'The scoring formula that produced this row. Two snapshots with different versions are not comparable and the UI must refuse to draw a delta across them.';
comment on column engineer_score_snapshots.captured_for is
  'The day the measured window ended. The uniqueness key, so re-running a capture replaces the day rather than appending a duplicate.';

create index if not exists engineer_score_snapshots_period_idx
  on engineer_score_snapshots (period_key, captured_for desc);

-- --- squads -------------------------------------------------------------------

create table if not exists squad_score_snapshots (
  id                 uuid primary key default extensions.gen_random_uuid(),
  squad_id           uuid not null references squads(id) on delete cascade,
  period_key         text not null,
  captured_for       date not null,
  definition_version text not null,

  score              numeric,
  throughput_score   numeric,
  flow_score         numeric,
  quality_score      numeric,
  collaboration_score numeric,

  rank_in_org        int,
  headcount          int,

  score_confidence   text,
  confidence_reason  text,
  throughput_basis   text,

  window_from        timestamptz not null,
  window_to          timestamptz not null,
  captured_at        timestamptz not null default now(),

  unique (squad_id, period_key, captured_for)
);

comment on column squad_score_snapshots.definition_version is
  'The scoring formula that produced this row. Squad scores are absolute rather than relative, so a version change here moves the thresholds, not the cohort — and the delta is just as meaningless across one.';

create index if not exists squad_score_snapshots_period_idx
  on squad_score_snapshots (period_key, captured_for desc);

-- --- the capture --------------------------------------------------------------
--
-- Calls the existing RPCs rather than reimplementing the scoring. That is the whole
-- design: there is exactly one definition of a score in this database, so a snapshot
-- can never disagree with the live page for the same window.
--
-- Idempotent on (subject, period, captured_for). `definition_version` is
-- deliberately not part of the key — a re-capture after a formula change should
-- replace the day's number and relabel it, not leave two rows for one day that a
-- naive reader would diff.

create or replace function capture_score_snapshots(
  p_period_key text,
  p_from       timestamptz,
  p_to         timestamptz
)
returns table (subject text, rows_written int)
language plpgsql
volatile
set search_path = public, extensions
as $fn$
declare
  v_version      text := score_definition_version();
  v_captured_for date := (p_to at time zone 'utc')::date;
  v_engineers    int;
  v_squads       int;
begin
  if p_period_key is null or p_period_key = '' then
    raise exception 'capture_score_snapshots needs a period key, e.g. ''90d''';
  end if;
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'capture_score_snapshots needs a window with from < to';
  end if;

  insert into engineer_score_snapshots (
    engineer_id, period_key, captured_for, definition_version,
    score, throughput_score, flow_score, quality_score, collaboration_score,
    rank_in_org, rank_at_level, peers_at_level, seniority_key, squad_id,
    score_confidence, confidence_reason,
    signals_above, signals_below, signals_read, net, standing, throughput_basis,
    window_from, window_to
  )
  select
    e.engineer_id, p_period_key, v_captured_for, v_version,
    e.score, e.throughput_score, e.flow_score, e.quality_score, e.collaboration_score,
    e.rank_in_org, e.rank_at_level, e.peers_at_level, e.seniority_key, e.squad_id,
    e.score_confidence, e.confidence_reason,
    e.signals_above, e.signals_below, e.signals_read, e.net, e.standing, e.throughput_basis,
    p_from, p_to
  from engineer_outliers(p_from, p_to, null) e
  on conflict (engineer_id, period_key, captured_for) do update set
    definition_version  = excluded.definition_version,
    score               = excluded.score,
    throughput_score    = excluded.throughput_score,
    flow_score          = excluded.flow_score,
    quality_score       = excluded.quality_score,
    collaboration_score = excluded.collaboration_score,
    rank_in_org         = excluded.rank_in_org,
    rank_at_level       = excluded.rank_at_level,
    peers_at_level      = excluded.peers_at_level,
    seniority_key       = excluded.seniority_key,
    squad_id            = excluded.squad_id,
    score_confidence    = excluded.score_confidence,
    confidence_reason   = excluded.confidence_reason,
    signals_above       = excluded.signals_above,
    signals_below       = excluded.signals_below,
    signals_read        = excluded.signals_read,
    net                 = excluded.net,
    standing            = excluded.standing,
    throughput_basis    = excluded.throughput_basis,
    window_from         = excluded.window_from,
    window_to           = excluded.window_to,
    captured_at         = now();

  get diagnostics v_engineers = row_count;

  insert into squad_score_snapshots (
    squad_id, period_key, captured_for, definition_version,
    score, throughput_score, flow_score, quality_score, collaboration_score,
    rank_in_org, headcount,
    score_confidence, confidence_reason, throughput_basis,
    window_from, window_to
  )
  select
    s.squad_id, p_period_key, v_captured_for, v_version,
    s.score, s.throughput_score, s.flow_score, s.quality_score, s.collaboration_score,
    s.rank_in_org, s.headcount,
    s.score_confidence, s.confidence_reason, s.throughput_basis,
    p_from, p_to
  from squad_outliers(p_from, p_to) s
  on conflict (squad_id, period_key, captured_for) do update set
    definition_version  = excluded.definition_version,
    score               = excluded.score,
    throughput_score    = excluded.throughput_score,
    flow_score          = excluded.flow_score,
    quality_score       = excluded.quality_score,
    collaboration_score = excluded.collaboration_score,
    rank_in_org         = excluded.rank_in_org,
    headcount           = excluded.headcount,
    score_confidence    = excluded.score_confidence,
    confidence_reason   = excluded.confidence_reason,
    throughput_basis    = excluded.throughput_basis,
    window_from         = excluded.window_from,
    window_to           = excluded.window_to,
    captured_at         = now();

  get diagnostics v_squads = row_count;

  return query
    select 'engineers'::text, v_engineers
    union all
    select 'squads'::text, v_squads;
end
$fn$;

comment on function capture_score_snapshots(text, timestamptz, timestamptz) is
  'Writes today''s engineer and squad scores to the snapshot tables, stamped with the current definition version. Idempotent on (subject, period, captured_for).';

-- --- grants -------------------------------------------------------------------
-- 0021's posture, applied to tables as well as functions: anon executes and reads
-- nothing, even though RLS would return an unauthenticated caller no rows anyway.
-- Production is publicly reachable, so the grant and the policy are two independent
-- locks rather than one with a spare.

alter table engineer_score_snapshots enable row level security;
alter table squad_score_snapshots    enable row level security;

drop policy if exists engineer_score_snapshots_viewer_select on engineer_score_snapshots;
create policy engineer_score_snapshots_viewer_select on engineer_score_snapshots
  for select to authenticated using (is_app_viewer());

drop policy if exists squad_score_snapshots_viewer_select on squad_score_snapshots;
create policy squad_score_snapshots_viewer_select on squad_score_snapshots
  for select to authenticated using (is_app_viewer());

revoke all on table engineer_score_snapshots from public, anon;
revoke all on table squad_score_snapshots    from public, anon;

grant select on table engineer_score_snapshots to authenticated;
grant select on table squad_score_snapshots    to authenticated;
grant select, insert, update, delete on table engineer_score_snapshots to service_role;
grant select, insert, update, delete on table squad_score_snapshots    to service_role;

revoke all on function score_definition_version()                              from public, anon;
revoke all on function capture_score_snapshots(text, timestamptz, timestamptz) from public, anon;

grant execute on function score_definition_version()                              to authenticated, service_role;
grant execute on function capture_score_snapshots(text, timestamptz, timestamptz) to authenticated, service_role;
