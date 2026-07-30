-- =============================================================================
-- 0024_authored_churn.sql — weigh the lines a person wrote, not the lines that moved
-- =============================================================================
--
-- 0022 weighed a merge request by its churn. That has one bad failure, and it is
-- common: a dependency bump rewrites package-lock.json by five thousand lines and
-- contains no engineering. Under a pure churn weight it scores the 6.0 cap — the
-- same gaming the metric exists to prevent, arriving from the opposite direction.
--
-- GitLab's GraphQL `mergeRequest.diffStats` gives per-file paths and line counts
-- without the diff bodies the REST endpoints bundle in, so the fix is to classify
-- the files (`src/lib/sync/file-classes.ts`) and store what a person actually wrote:
--
--   churn_authored   churn with generated files excluded — lockfiles, dist/,
--                    vendor/, snapshots, *.min.js, protobuf output
--   modules_touched  distinct directories, which is the honest breadth signal;
--                    a file count says "30 files" where a module count says
--                    "one directory, mechanically"
--   generated_pct    how much of the diff was noise, so a suspicious weight can be
--                    checked rather than argued about
--   test_ratio       test churn over source churn. Reported, never scored: it is
--                    evidence the size was real work, and scoring it would just
--                    make people write tests to move a number.
--
-- Two deliberate choices in how these feed the weight:
--
--   * Authored churn is used where it is known, total churn where it is not. Rows
--     measured by summing commits have no paths, so they cannot have an authored
--     figure. Mixing the two is defensible because the direction is consistent —
--     authored is never larger than total — so a row without paths can only ever
--     overstate itself, and `size_source` says which is which.
--   * Breadth switches from files to modules where known. Modules are a smaller
--     number, so the multiplier is gentler; that is the point. Thirty files in one
--     directory is one change, and the file count was flattering it.

-- --- columns ------------------------------------------------------------------

alter table merge_requests
  add column if not exists churn_authored  int,
  add column if not exists files_authored  int,
  add column if not exists modules_touched int,
  add column if not exists generated_pct   numeric,
  add column if not exists test_ratio      numeric;

comment on column merge_requests.churn_authored is
  'Churn excluding generated files (lockfiles, build output, snapshots, protobuf). NULL when the size came from a source without file paths. This is what the complexity weight uses where it is available.';
comment on column merge_requests.modules_touched is
  'Distinct directories touched. The breadth signal a file count overstates — thirty files in one directory is one change.';
comment on column merge_requests.test_ratio is
  'Test churn over source churn. Reported, never scored: scoring it would make people write tests to move a number.';

-- GraphQL joins the list of places a size can come from, ahead of the others
-- because it is exact and carries paths.
alter table merge_requests drop constraint if exists merge_requests_size_source_check;
alter table merge_requests add constraint merge_requests_size_source_check
  check (size_source in ('graphql_diff_stats', 'diff_stats', 'changes_count', 'commits_sum', 'unavailable'));

-- --- the view every complexity figure reads -----------------------------------

-- Dropped rather than replaced: a new column in the middle of the list is not
-- something CREATE OR REPLACE VIEW can express.
drop view if exists v_mr_size;

create view v_mr_size with (security_invoker = true) as
select
  mr.id                                   as merge_request_id,
  mr.author_engineer_id,
  mr.merged_at,
  mr.state,
  mr.is_draft,
  mr.size_source,
  -- Authored where known, total where not. Never zero for an unmeasured row: that
  -- distinction is the whole reason size_source exists.
  case when mr.size_source in ('graphql_diff_stats', 'diff_stats', 'commits_sum')
       then coalesce(mr.churn_authored, mr.additions + mr.deletions) end   as churn,
  -- Kept alongside so a weight built on authored churn can be compared with the
  -- raw diff it came from.
  case when mr.size_source in ('graphql_diff_stats', 'diff_stats', 'commits_sum')
       then mr.additions + mr.deletions end                                as churn_total,
  case when mr.size_source is null or mr.size_source = 'unavailable' then null
       else mr.changed_files end                                           as changed_files,
  -- Breadth: modules where the paths were available, files otherwise.
  case when mr.size_source is null or mr.size_source = 'unavailable' then null
       else coalesce(mr.modules_touched, mr.changed_files) end             as breadth,
  mr.generated_pct,
  mr.test_ratio,
  mr.commits_count
from merge_requests mr
where not exists (
        select 1 from v_ignored_engineers ig where ig.id = mr.author_engineer_id);

comment on view v_mr_size is
  'Per-merge-request size, with unmeasured rows as NULL rather than zero, churn preferring the lines a person wrote, and breadth preferring modules over files.';

-- --- the two complexity aggregates, now weighing breadth by module ------------

drop function if exists engineer_complexity(timestamptz, timestamptz);

create function engineer_complexity(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  engineer_id        uuid,
  merged_mrs         int,
  sized_mrs          int,
  sized_mr_pct       numeric,
  median_churn       numeric,
  org_median_churn   numeric,
  effective_mrs      numeric,
  points_per_mr      numeric,
  trivial_mrs        int,
  trivial_mr_pct     numeric,
  large_mrs          int,
  max_points         numeric,
  median_generated_pct numeric,
  median_test_ratio    numeric
)
language sql
stable
set search_path = public, extensions
as $fn$
with merged as (
  select * from v_mr_size
  where merged_at >= p_from and merged_at < p_to and author_engineer_id is not null
),
org as (
  select percentile_cont(0.5) within group (order by churn)::numeric as median_churn
  from merged where churn is not null
),
scored as (
  select
    m.*,
    mr_complexity_points(m.churn, m.breadth, org.median_churn) as points,
    org.median_churn                                           as org_median
  from merged m cross join org
)
select
  s.author_engineer_id,
  count(*)::int,
  count(*) filter (where s.churn is not null)::int,
  round(100.0 * count(*) filter (where s.churn is not null) / nullif(count(*), 0)::numeric, 1),
  round(percentile_cont(0.5) within group (order by s.churn)::numeric, 0),
  round(max(s.org_median)::numeric, 0),
  round(sum(s.points), 2),
  round(sum(s.points) / nullif(count(*) filter (where s.points is not null), 0), 2),
  count(*) filter (where s.points = 0.1)::int,
  round(100.0 * count(*) filter (where s.points = 0.1)
        / nullif(count(*) filter (where s.points is not null), 0)::numeric, 1),
  count(*) filter (where s.churn > 400)::int,
  max(s.points),
  round(percentile_cont(0.5) within group (order by s.generated_pct)::numeric, 1),
  round(percentile_cont(0.5) within group (order by s.test_ratio)::numeric, 2)
from scored s
group by s.author_engineer_id;
$fn$;

create or replace function squad_complexity(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  squad_id       uuid,
  merged_mrs     int,
  sized_mr_pct   numeric,
  median_churn   numeric,
  effective_mrs  numeric,
  points_per_mr  numeric,
  trivial_mr_pct numeric
)
language sql
stable
set search_path = public, extensions
as $fn$
with merged as (
  select m.squad_id, s.churn, s.breadth
  from v_merge_requests m
  join v_mr_size s on s.merge_request_id = m.id
  where m.merged_at >= p_from and m.merged_at < p_to and m.squad_id is not null
),
org as (
  select percentile_cont(0.5) within group (order by churn)::numeric as median_churn
  from merged where churn is not null
),
scored as (
  select m.*, mr_complexity_points(m.churn, m.breadth, org.median_churn) as points
  from merged m cross join org
)
select
  s.squad_id,
  count(*)::int,
  round(100.0 * count(*) filter (where s.churn is not null) / nullif(count(*), 0)::numeric, 1),
  round(percentile_cont(0.5) within group (order by s.churn)::numeric, 0),
  round(sum(s.points), 2),
  round(sum(s.points) / nullif(count(*) filter (where s.points is not null), 0), 2),
  round(100.0 * count(*) filter (where s.points = 0.1)
        / nullif(count(*) filter (where s.points is not null), 0)::numeric, 1)
from scored s
group by s.squad_id;
$fn$;

revoke all on function engineer_complexity(timestamptz, timestamptz) from public, anon;
revoke all on function squad_complexity(timestamptz, timestamptz)    from public, anon;
grant execute on function engineer_complexity(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function squad_complexity(timestamptz, timestamptz)    to authenticated, service_role;
