-- 0029_close_abandoned_sync_runs.sql
--
-- Close sync runs that never reported a result, and make finding them cheap.
--
-- WHY THIS EXISTS
--
-- `SyncContext.finish()` is the only writer of a terminal status and it runs inside
-- the same invocation as the work. Anything that ends that invocation without
-- unwinding — exceeding `maxDuration`, an out-of-memory kill, a local process stopped
-- by hand — leaves the row saying `running` for ever, because the thing that would
-- have corrected it is the thing that died.
--
-- On 2026-07-31 production held four such rows, all `gitlab`/`backfill`, opened on
-- 2026-07-28 at 16:26, 18:32, 19:30 and 22:43 UTC. They were not merely untidy:
--
--   * `readSourceHealth` counted any `running` row as a run in flight, so a scheduler
--     that had stopped firing altogether presented as a sync mid-work. Three days of
--     nothing happening looked like something happening.
--   * `getSyncRuns` on /admin showed three-day-old runs as live.
--
-- The code side of this is fixed independently of this file: `expireAbandonedRuns`
-- (src/lib/sync/runner.ts) closes anything open past 20 minutes at the top of every
-- sync, and `readSourceHealth` no longer believes a `running` row past the same
-- horizon. So a future abandoned run is self-correcting, and this migration exists
-- only to clear the four that predate the fix — nothing schedules it, and nothing
-- depends on it having been applied.
--
-- WHY 20 MINUTES
--
-- Both cron routes declare `maxDuration = 300`, so no invocation can legitimately
-- outlive five minutes of wall clock. Twenty is four times that: generous enough that
-- a genuinely slow run is never mislabelled, short enough that an abandoned one is
-- visible the same morning. The constant lives in TypeScript (`STALE_RUN_AFTER_MS`)
-- and is restated here rather than shared, because a migration cannot import; if the
-- two ever disagree the TypeScript one is authoritative, since it is the one that runs
-- every day.
--
-- WHY 'error' AND NOT 'partial'
--
-- `partial` is a designed, healthy outcome: a time-budgeted run that stopped cleanly,
-- wrote its cursors, and recorded stats a later run resumes from. An abandoned run has
-- none of that — no cursor advance it can vouch for, no stats, no log. Filing it as
-- `partial` would put it in the same bucket as the 54 legitimate partials and quietly
-- corrupt the "N runs in a row stopped early" signal that exists to catch a walk that
-- is not converging.
--
-- `duration_ms` is deliberately left null. We never learned how long these ran, and
-- writing `now() - started_at` would record three days of nothing as three days of work.
--
-- SAFE TO RE-RUN. The predicate excludes anything already terminal, so a second
-- application is a no-op. It cannot touch a live run: a run opened less than 20
-- minutes ago is out of scope by construction.
--
-- TO REVERSE: there is no honest reverse. The original rows carried no result, so
-- reverting would mean re-asserting a `running` state that was never true after the
-- invocation died. If it must be undone for a rollback:
--
--   update public.sync_runs
--      set status = 'running', finished_at = null, error = null
--    where error like 'Abandoned:%';
--
-- Grants: none. This file adds no privileges to any role, and in particular nothing
-- to `anon`.

-- An index for the reaper's predicate. It runs on every sync and asks exactly this
-- question — open rows older than a cutoff — and sync_runs only grows.
create index if not exists sync_runs_status_started_at_idx
  on public.sync_runs (status, started_at desc);

update public.sync_runs
   set status = 'error',
       finished_at = coalesce(finished_at, now()),
       error = 'Abandoned: no terminal status was ever written. The invocation ended between start and finish — a timeout, an out-of-memory kill, or a process stopped by hand — so this run was closed by the next sync rather than by itself.'
 where status = 'running'
   and started_at < now() - interval '20 minutes';
