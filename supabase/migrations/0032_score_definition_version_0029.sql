-- =============================================================================
-- 0032_score_definition_version_0029.sql — 0029 changed the formula and did not say so
-- =============================================================================
--
-- `0025_score_snapshots.sql` built `definition_version` for one purpose, and stated
-- the obligation that comes with it plainly: "Bump that setting in the same
-- migration that changes any scoring input, and every later snapshot is correctly
-- labelled incomparable with everything before it."
--
-- **0029 did not do that.** It moved five volume inputs in `engineer_outliers` from
-- running totals to per-active-week rates — a change that shifted every senior's
-- score — and left `app_settings.score_definition_version` reading
-- `'0024-authored-churn'`. So the capture taken on 2026-07-31 under the old formula
-- and the captures taken on 2026-08-04 under the new one carry the *same* version
-- string, which is precisely the false continuity the column exists to prevent.
--
-- Nothing surfaced it until the history charts were built, because until then
-- nothing read the column. The first thing those charts would have done is draw one
-- confident line straight across a formula change.
--
-- This migration does two things
-- ------------------------------
--   1. **Bumps the setting to `'0029-tenure-rates'`,** so every future capture is
--      labelled correctly.
--   2. **Re-stamps the snapshots that were already computed under 0029.** A bump
--      alone would leave today's rows lying about which formula produced them, and
--      those are the rows the charts are about to read. The split is decided by
--      `captured_at` against the moment 0029 was applied, read out of
--      `supabase_migrations.schema_migrations` rather than hardcoded — the database
--      already knows when it happened and should not be told twice.
--
-- Why re-stamp rather than delete and recapture: the numbers in those rows are
-- correct. They were computed by the current function over the current data; only
-- the label is wrong. Deleting them would throw away a real reading and, for the
-- '30d' series, the only reading there is.
--
-- What this deliberately does not do: touch the 2026-07-31 capture. It genuinely
-- was produced by the pre-0029 formula, so `'0024-authored-churn'` is the truth
-- about it. After this migration the 90d series correctly spans two versions and
-- the charts will correctly refuse to join them — which is the honest outcome, not
-- a regression. `Movers` will show nothing for that pair until a second post-0029
-- capture lands tonight, and says so in its own words.
--
-- To reverse:
--   update app_settings set value = '"0024-authored-churn"'::jsonb
--     where key = 'score_definition_version';
--   update engineer_score_snapshots set definition_version = '0024-authored-churn'
--     where definition_version = '0029-tenure-rates';
--   update squad_score_snapshots set definition_version = '0024-authored-churn'
--     where definition_version = '0029-tenure-rates';

update app_settings
   set value = '"0029-tenure-rates"'::jsonb
 where key = 'score_definition_version';

-- Re-stamp anything captured after 0029 landed. `captured_at` is the write time,
-- which is the right clock here: it says which version of the function ran, where
-- `captured_for` only says which window was measured.
with applied as (
  select to_timestamp(version, 'YYYYMMDDHH24MISS') at time zone 'utc' as at
    from supabase_migrations.schema_migrations
   where name = 'tenure_normalised_cohorts'
)
update engineer_score_snapshots s
   set definition_version = '0029-tenure-rates'
  from applied a
 where s.captured_at > a.at
   and s.definition_version = '0024-authored-churn';

with applied as (
  select to_timestamp(version, 'YYYYMMDDHH24MISS') at time zone 'utc' as at
    from supabase_migrations.schema_migrations
   where name = 'tenure_normalised_cohorts'
)
update squad_score_snapshots s
   set definition_version = '0029-tenure-rates'
  from applied a
 where s.captured_at > a.at
   and s.definition_version = '0024-authored-churn';
