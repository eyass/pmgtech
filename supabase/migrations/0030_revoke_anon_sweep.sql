-- =============================================================================
-- 0030_revoke_anon_sweep.sql — finish what 0028 started
-- =============================================================================
--
-- 0028 revoked the bootstrap `anon` grants on `engineers` and said the remaining
-- ~20 tables `0006_security.sql` lists were in the same position and wanted their
-- own migration with their own verification. This is that migration. The real
-- count is 41 objects, not 20: 27 tables and 14 views.
--
-- After this, `anon` holds no privilege on anything in `public`. The five objects
-- already closed — `engineers` (0028) and `metric_targets`, `metric_target_changes`,
-- `engineer_score_snapshots`, `squad_score_snapshots` (revoked in the migrations
-- that created them) — are deliberately not repeated here.
--
-- Verified before applying
-- ------------------------
--   1. **Nothing in the application reads `public` with the anon key.** There are
--      exactly three anon-key clients: `components/sign-in.tsx` (OAuth start),
--      `proxy.ts` (middleware session refresh) and `lib/supabase/server.ts`. The
--      third is used by four callers — the signout and callback routes, `lib/auth.ts`
--      and `lib/sync/auth.ts` — and every one of them calls only `auth.getUser`,
--      `auth.signOut` or `auth.exchangeCodeForSession`, which touch the `auth`
--      schema. Every `.from(...)`/`.rpc(...)` in the app resolves to the
--      service-role client in `lib/supabase/admin.ts`, including the sync modules,
--      which take an injected `SupabaseClient` that `lib/sync/runner.ts` fills with
--      `supabaseAdmin()`. `lib/auth.ts` is the one file holding both clients, and
--      its `app_admins` read goes through the service-role one.
--   2. **`authenticated` and `service_role` are untouched.** Both hold their own
--      explicit grants on all 46 objects (322 apiece), independent of anon's 287.
--      A signed-in reader loses nothing.
--   3. **Only `anon` needs revoking.** Nothing here is granted to the PUBLIC
--      pseudo-role — checked via `aclexplode(...) where grantee = 0` across all 46
--      objects, false everywhere. That is why this migration says `from anon` and
--      not `from public, anon` as the newer tables do: there is no PUBLIC grant to
--      take away, and naming one would imply there had been.
--
-- As with 0028, this is defence in depth rather than an incident. RLS is enabled on
-- all 27 tables and no policy reaches `anon`, and the 14 views are all
-- `security_invoker = true`, so they defer to the RLS on the tables underneath
-- rather than bypassing it. Nothing was readable in practice. What changes is that
-- the grant and the policy are now two independent locks on every object instead of
-- one lock and a spare on most of them.
--
-- To reverse (restores the bootstrap posture, not recommended):
--   grant select, insert, update, references on all tables in schema public to anon;
--
-- Deliberately NOT done here: sequence and routine privileges. `0006` revoked the
-- default execute grant on functions, and the migrations since have each restated
-- it, so routines are already in hand. Sequences have not been audited and are a
-- separate question — anon cannot reach one without an INSERT privilege it no
-- longer has on any table, so this is a tidiness matter rather than a gap.

-- --- tables (27) --------------------------------------------------------------
-- Application and configuration
revoke all on table app_admins, app_settings, performance_dimensions,
                    seniority_levels, seniority_title_patterns, squads
  from anon;

-- Engineer directory satellites
revoke all on table engineer_assessments, assessment_summaries, engineer_identities,
                    excluded_accounts, unmatched_identities
  from anon;

-- GitLab ingest
revoke all on table gitlab_commits, gitlab_deployments, gitlab_pipelines,
                    gitlab_projects, merge_requests, merge_request_notes,
                    deployment_merge_requests
  from anon;

-- Jira ingest
revoke all on table jira_boards, jira_issues, jira_issue_sprints, jira_projects,
                    jira_sprints, jira_status_transitions, issue_merge_requests
  from anon;

-- Sync bookkeeping
revoke all on table sync_cursors, sync_runs
  from anon;

-- --- views (14) ---------------------------------------------------------------
-- All security_invoker, so these already deferred to the RLS on the tables above.
-- Revoked anyway, so that reading a view and reading its base table require the
-- same thing of the caller.
revoke all on table v_commits, v_deployment_recovery, v_engineers,
                    v_ignored_engineers, v_issue_flow, v_jira_issues,
                    v_merge_requests, v_mr_iterations, v_mr_size,
                    v_prod_deployments, v_prod_releases, v_release_recovery,
                    v_reverts, v_review_events
  from anon;
