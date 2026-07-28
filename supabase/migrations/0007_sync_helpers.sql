-- =============================================================================
-- 0007_sync_helpers.sql — write-side helpers used by the sync pipeline
-- =============================================================================

-- Deployments need the raw GitLab user id so they can be re-attributed later,
-- the same way merge requests and notes already can be.
alter table gitlab_deployments
  add column if not exists deployed_by_gitlab_id text;

-- --- batched unmatched-identity upsert ---------------------------------------
-- A backfill can see the same unmapped GitLab user thousands of times. The sync
-- accumulates counts in memory and calls this once, incrementing rather than
-- overwriting event_count so the triage list stays meaningful across runs.

create or replace function upsert_unmatched_identities(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  affected int;
begin
  insert into unmatched_identities
    (provider, external_id, external_handle, display_name, email, event_count, last_seen_at)
  select
    r->>'provider',
    r->>'external_id',
    nullif(r->>'external_handle', ''),
    nullif(r->>'display_name', ''),
    nullif(r->>'email', ''),
    coalesce((r->>'event_count')::int, 1),
    coalesce((r->>'last_seen_at')::timestamptz, now())
  from jsonb_array_elements(p_rows) as r
  on conflict (provider, external_id) do update
    set event_count     = unmatched_identities.event_count + excluded.event_count,
        last_seen_at    = greatest(unmatched_identities.last_seen_at, excluded.last_seen_at),
        external_handle = coalesce(excluded.external_handle, unmatched_identities.external_handle),
        display_name    = coalesce(excluded.display_name, unmatched_identities.display_name),
        email           = coalesce(excluded.email, unmatched_identities.email);

  get diagnostics affected = row_count;
  return affected;
end $fn$;

revoke all on function upsert_unmatched_identities(jsonb) from public, anon;
grant execute on function upsert_unmatched_identities(jsonb) to service_role;

-- --- historical re-attribution ------------------------------------------------
-- When someone is mapped by hand in the admin screen, their past work should
-- appear under their name immediately rather than waiting for a full re-sync.
-- This walks every table that stores a raw external id and fills in the
-- engineer_id, then clears the now-resolved triage rows.

create or replace function reattribute_from_identities()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  mrs int; notes int; commits_ int; deploys int; issues_a int; issues_r int; transitions int;
begin
  update merge_requests mr
     set author_engineer_id = ei.engineer_id
    from engineer_identities ei
   where ei.provider = 'gitlab'
     and ei.external_id = mr.author_gitlab_id
     and mr.author_engineer_id is distinct from ei.engineer_id;
  get diagnostics mrs = row_count;

  update merge_request_notes n
     set author_engineer_id = ei.engineer_id
    from engineer_identities ei
   where ei.provider = 'gitlab'
     and ei.external_id = n.author_gitlab_id
     and n.author_engineer_id is distinct from ei.engineer_id;
  get diagnostics notes = row_count;

  -- Commits are matched on the author email recorded in the git metadata, which
  -- is often a personal address; both engineers.email and any extra 'email'
  -- identity are considered.
  update gitlab_commits c
     set author_engineer_id = m.engineer_id
    from (
      select lower(email) as email, id as engineer_id from engineers where email is not null
      union
      select lower(external_id) as email, engineer_id from engineer_identities where provider = 'email'
    ) m
   where lower(c.author_email) = m.email
     and c.author_engineer_id is distinct from m.engineer_id;
  get diagnostics commits_ = row_count;

  update gitlab_deployments d
     set deployed_by_engineer_id = ei.engineer_id
    from engineer_identities ei
   where ei.provider = 'gitlab'
     and ei.external_id = d.deployed_by_gitlab_id
     and d.deployed_by_engineer_id is distinct from ei.engineer_id;
  get diagnostics deploys = row_count;

  update jira_issues i
     set assignee_engineer_id = ei.engineer_id
    from engineer_identities ei
   where ei.provider = 'jira'
     and ei.external_id = i.assignee_jira_id
     and i.assignee_engineer_id is distinct from ei.engineer_id;
  get diagnostics issues_a = row_count;

  update jira_issues i
     set reporter_engineer_id = ei.engineer_id
    from engineer_identities ei
   where ei.provider = 'jira'
     and ei.external_id = i.reporter_jira_id
     and i.reporter_engineer_id is distinct from ei.engineer_id;
  get diagnostics issues_r = row_count;

  update jira_status_transitions t
     set author_engineer_id = ei.engineer_id
    from engineer_identities ei
   where ei.provider = 'jira'
     and ei.external_id = t.author_jira_id
     and t.author_engineer_id is distinct from ei.engineer_id;
  get diagnostics transitions = row_count;

  -- Anything now mapped no longer needs triage.
  delete from unmatched_identities u
   using engineer_identities ei
   where ei.provider = u.provider
     and ei.external_id = u.external_id;

  return jsonb_build_object(
    'merge_requests', mrs,
    'notes', notes,
    'commits', commits_,
    'deployments', deploys,
    'issues_assignee', issues_a,
    'issues_reporter', issues_r,
    'transitions', transitions
  );
end $fn$;

revoke all on function reattribute_from_identities() from public, anon;
grant execute on function reattribute_from_identities() to service_role;

-- --- derived MR review timestamps --------------------------------------------
-- first_review_at / first_approval_at / distinct_reviewers depend on the notes
-- belonging to an MR, so they are computed after notes are written rather than
-- guessed during the MR upsert.

create or replace function recompute_mr_review_stats(p_mr_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  affected int;
begin
  with stats as (
    select
      n.merge_request_id                                          as mr_id,
      min(n.created_at) filter (where n.kind in ('comment','approval'))  as first_review_at,
      min(n.created_at) filter (where n.kind = 'approval')                as first_approval_at,
      count(distinct n.author_engineer_id)
        filter (where n.kind in ('comment','approval'))                   as distinct_reviewers,
      count(*) filter (where n.kind = 'comment')::int                     as notes_count,
      count(*) filter (where n.kind = 'approval')::int                    as approvals_count
    from merge_request_notes n
    join merge_requests mr on mr.id = n.merge_request_id
    where (p_mr_ids is null or n.merge_request_id = any(p_mr_ids))
      -- Self-comments are not reviews.
      and (n.author_engineer_id is null or n.author_engineer_id is distinct from mr.author_engineer_id)
    group by n.merge_request_id
  )
  update merge_requests mr
     set first_review_at    = stats.first_review_at,
         first_approval_at  = stats.first_approval_at,
         distinct_reviewers = stats.distinct_reviewers,
         notes_count        = stats.notes_count,
         approvals_count    = greatest(mr.approvals_count, stats.approvals_count)
    from stats
   where mr.id = stats.mr_id;

  get diagnostics affected = row_count;
  return affected;
end $fn$;

revoke all on function recompute_mr_review_stats(uuid[]) from public, anon;
grant execute on function recompute_mr_review_stats(uuid[]) to service_role;

-- --- link merge requests to Jira issues --------------------------------------
-- merge_requests.jira_keys is populated during the GitLab sync from the MR
-- title/branch/description. This turns those keys into real rows once the
-- matching issues exist, in either sync order.

create or replace function link_mrs_to_issues()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  affected int;
begin
  insert into issue_merge_requests (issue_id, merge_request_id)
  select i.id, mr.id
  from merge_requests mr
  cross join lateral unnest(mr.jira_keys) as k(jira_key)
  join jira_issues i on i.key = k.jira_key
  on conflict do nothing;

  get diagnostics affected = row_count;
  return affected;
end $fn$;

revoke all on function link_mrs_to_issues() from public, anon;
grant execute on function link_mrs_to_issues() to service_role;

-- --- derive first_in_progress_at from the changelog --------------------------

create or replace function recompute_issue_cycle_starts(p_issue_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  affected int;
begin
  with firsts as (
    select t.issue_id, min(t.created_at) as first_in_progress_at
    from jira_status_transitions t
    where t.to_category = 'In Progress'
      and (p_issue_ids is null or t.issue_id = any(p_issue_ids))
    group by t.issue_id
  )
  update jira_issues i
     set first_in_progress_at = firsts.first_in_progress_at
    from firsts
   where i.id = firsts.issue_id
     and i.first_in_progress_at is distinct from firsts.first_in_progress_at;

  get diagnostics affected = row_count;
  return affected;
end $fn$;

revoke all on function recompute_issue_cycle_starts(uuid[]) from public, anon;
grant execute on function recompute_issue_cycle_starts(uuid[]) to service_role;
