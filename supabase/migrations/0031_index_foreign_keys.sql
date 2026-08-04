-- =============================================================================
-- 0031_index_foreign_keys.sql — cover the foreign keys that had no index
-- =============================================================================
--
-- The Supabase performance advisor flags twelve foreign keys in `public` with no
-- covering index. An unindexed foreign key costs twice: joins across it fall back
-- to a sequential scan, and every delete or key update on the *parent* table has
-- to scan the whole child table to enforce the constraint. The second cost is the
-- one that bites here — `engineers` and `squads` are edited from the admin page,
-- and each edit was scanning `jira_issues`, `jira_status_transitions` and
-- `gitlab_deployments` in full.
--
-- Sizes at the time of writing, which is why this is worth doing rather than
-- theoretical: `gitlab_deployments` ~104,800 rows, `jira_status_transitions`
-- ~10,900, `jira_issues` ~3,400, `merge_requests` ~2,000, `jira_sprints` ~890,
-- `issue_merge_requests` ~1,280. The rest are small enough that the index is
-- bookkeeping, but a consistent rule is easier to keep than a size threshold that
-- has to be rechecked as the tables grow.
--
-- Two choices worth recording
-- ---------------------------
--   1. **Plain indexes, not partial ones.** Several of these columns are sparsely
--      populated — most deployments have no resolved engineer — so
--      `where col is not null` would be smaller, and would still serve equality
--      lookups since a non-null constant implies non-null. It is not worth it: the
--      whole set is a few megabytes at these sizes, and a partial index quietly
--      stops helping the moment someone writes `where col is null` to audit
--      unresolved rows, which on this data is a query people actually want.
--   2. **`create index`, not `create index concurrently`.** Concurrent builds
--      cannot run inside a transaction, and a migration should be one. The write
--      lock is held for the length of a build over ~105k narrow rows, which is
--      well under a second, and the sync only writes on the 03:00 cron.
--
-- Deliberately NOT done here: the advisor also reports twelve *unused* indexes.
-- They are left alone. "Never used" is measured from statistics that reset on
-- restart, several of them cover admin paths that run rarely by design, and
-- dropping an index that a future plan needs is a harder failure to spot than the
-- disk it costs. That wants profiling against real query plans, not a linter row.
--
-- To reverse:
--   drop index if exists deployment_merge_requests_mr_idx, engineer_assessments_dimension_idx,
--     engineers_seniority_idx, gitlab_deployments_deployed_by_idx, issue_merge_requests_mr_idx,
--     jira_issues_reporter_idx, jira_issues_squad_idx, jira_projects_squad_idx,
--     jira_sprints_board_idx, jira_status_transitions_author_idx,
--     merge_requests_merged_by_idx, seniority_title_patterns_seniority_idx;

-- --- child rows referencing merge_requests ------------------------------------
create index if not exists deployment_merge_requests_mr_idx
  on deployment_merge_requests (merge_request_id);

create index if not exists issue_merge_requests_mr_idx
  on issue_merge_requests (merge_request_id);

-- --- child rows referencing engineers -----------------------------------------
create index if not exists gitlab_deployments_deployed_by_idx
  on gitlab_deployments (deployed_by_engineer_id);

create index if not exists jira_issues_reporter_idx
  on jira_issues (reporter_engineer_id);

create index if not exists jira_status_transitions_author_idx
  on jira_status_transitions (author_engineer_id);

create index if not exists merge_requests_merged_by_idx
  on merge_requests (merged_by_engineer_id);

-- --- child rows referencing squads --------------------------------------------
create index if not exists jira_issues_squad_idx
  on jira_issues (squad_id);

create index if not exists jira_projects_squad_idx
  on jira_projects (squad_id);

-- --- child rows referencing the small lookup tables ---------------------------
create index if not exists engineers_seniority_idx
  on engineers (seniority_key);

create index if not exists seniority_title_patterns_seniority_idx
  on seniority_title_patterns (seniority_key);

create index if not exists engineer_assessments_dimension_idx
  on engineer_assessments (dimension_key);

create index if not exists jira_sprints_board_idx
  on jira_sprints (board_id);
