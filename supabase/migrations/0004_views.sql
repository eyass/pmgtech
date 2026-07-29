-- =============================================================================
-- 0004_views.sql — enriched views with squad attribution and derived durations
-- =============================================================================
-- security_invoker keeps these views subject to the caller's RLS rather than the
-- view owner's, which is both safer and what the Supabase linter expects.

-- --- engineers ----------------------------------------------------------------

create or replace view v_engineers with (security_invoker = true) as
select
  e.id,
  e.email,
  e.full_name,
  coalesce(e.display_name, e.full_name)          as display_name,
  e.avatar_url,
  e.job_title,
  e.department,
  e.site,
  e.manager_email,
  e.start_date,
  e.employment_type,
  e.is_active,
  e.include_in_metrics,
  e.hibob_id,
  e.seniority_key,
  sl.label                                        as seniority_label,
  coalesce(sl.rank, 0)                            as seniority_rank,
  e.squad_id,
  s.key                                           as squad_key,
  s.name                                          as squad_name,
  s.colour                                        as squad_colour,
  -- Tenure in whole months, used to avoid judging brand-new joiners on throughput
  case
    when e.start_date is null then null
    else floor(extract(epoch from (now() - e.start_date::timestamptz)) / 2629800.0)::int
  end                                             as tenure_months,
  (select gi.external_handle from engineer_identities gi
    where gi.engineer_id = e.id and gi.provider = 'gitlab' limit 1) as gitlab_username,
  (select ji.external_id from engineer_identities ji
    where ji.engineer_id = e.id and ji.provider = 'jira' limit 1)   as jira_account_id
from engineers e
left join squads s on s.id = e.squad_id
left join seniority_levels sl on sl.key = e.seniority_key;

-- --- merge requests -----------------------------------------------------------

create or replace view v_merge_requests with (security_invoker = true) as
select
  mr.id,
  mr.gitlab_id,
  mr.iid,
  mr.title,
  mr.state,
  mr.is_draft,
  mr.web_url,
  mr.labels,
  mr.jira_keys,
  mr.source_branch,
  mr.target_branch,

  mr.opened_at,
  mr.merged_at,
  mr.closed_at,
  mr.first_commit_at,
  mr.first_review_at,
  mr.first_approval_at,

  mr.additions,
  mr.deletions,
  mr.changed_files,
  mr.commits_count,
  mr.notes_count,
  mr.approvals_count,
  mr.distinct_reviewers,
  (mr.additions + mr.deletions)                       as churn,

  mr.author_engineer_id,
  e.full_name                                          as author_name,
  e.seniority_key                                      as author_seniority,
  e.avatar_url                                         as author_avatar_url,

  p.id                                                 as project_id,
  p.name                                               as project_name,
  p.path_with_namespace,

  -- Squad attribution is people-first: an MR belongs to the squad of whoever
  -- wrote it, falling back to the squad that owns the repo when the author is
  -- not yet mapped to an engineer.
  coalesce(e.squad_id, p.squad_id)                     as squad_id,

  -- Durations, all in hours and null-safe.
  extract(epoch from (mr.first_review_at - mr.opened_at)) / 3600.0   as hours_to_first_review,
  extract(epoch from (mr.merged_at - mr.opened_at)) / 3600.0          as hours_open_to_merge,
  extract(epoch from (mr.merged_at - coalesce(mr.first_commit_at, mr.opened_at))) / 3600.0
                                                                      as cycle_time_hours,
  extract(epoch from (mr.merged_at - mr.first_review_at)) / 3600.0     as hours_review_to_merge,
  extract(epoch from (coalesce(mr.merged_at, mr.closed_at, now()) - mr.opened_at)) / 3600.0
                                                                      as hours_alive
from merge_requests mr
left join engineers e on e.id = mr.author_engineer_id
join gitlab_projects p on p.id = mr.project_id;

-- --- review events ------------------------------------------------------------

create or replace view v_review_events with (security_invoker = true) as
select
  n.id,
  n.merge_request_id,
  n.kind,
  n.body_length,
  n.created_at,
  n.author_engineer_id                       as reviewer_engineer_id,
  re.full_name                               as reviewer_name,
  re.squad_id                                as reviewer_squad_id,
  re.seniority_key                           as reviewer_seniority,
  mr.author_engineer_id,
  ae.full_name                               as author_name,
  coalesce(ae.squad_id, p.squad_id)          as author_squad_id,
  -- Time the reviewer took to respond after the MR was opened.
  extract(epoch from (n.created_at - mr.opened_at)) / 3600.0 as response_hours
from merge_request_notes n
join merge_requests mr on mr.id = n.merge_request_id
join gitlab_projects p on p.id = mr.project_id
left join engineers re on re.id = n.author_engineer_id
left join engineers ae on ae.id = mr.author_engineer_id
where n.kind in ('comment', 'approval')
  -- A note by the MR author on their own MR is not a review.
  and (n.author_engineer_id is null or n.author_engineer_id <> mr.author_engineer_id);

-- --- commits ------------------------------------------------------------------

create or replace view v_commits with (security_invoker = true) as
select
  c.id,
  c.sha,
  c.title,
  c.authored_at,
  c.additions,
  c.deletions,
  (c.additions + c.deletions)        as churn,
  c.author_engineer_id,
  e.full_name                        as author_name,
  c.project_id,
  p.name                             as project_name,
  coalesce(e.squad_id, p.squad_id)   as squad_id
from gitlab_commits c
join gitlab_projects p on p.id = c.project_id
left join engineers e on e.id = c.author_engineer_id
where not c.is_merge_commit;

-- --- production deployments ---------------------------------------------------

create or replace view v_prod_deployments with (security_invoker = true) as
select
  d.id,
  d.environment,
  d.status,
  d.ref,
  d.sha,
  d.created_at,
  d.finished_at,
  d.project_id,
  p.name                              as project_name,
  coalesce(e.squad_id, p.squad_id)    as squad_id,
  (d.status = 'success')              as succeeded
from gitlab_deployments d
join gitlab_projects p on p.id = d.project_id
left join engineers e on e.id = d.deployed_by_engineer_id
where d.is_production
  and d.status in ('success', 'failed')
  and d.finished_at is not null;

-- For every failed production deployment, how long until the next successful one
-- on the same project+environment. Unrecovered failures are intentionally
-- excluded rather than counted as infinite, so MTTR stays a median of real
-- recoveries. Postgres has no IGNORE NULLS for lead(), hence the lateral.
create or replace view v_deployment_recovery with (security_invoker = true) as
select
  f.project_id,
  f.environment,
  f.squad_id,
  f.finished_at                                                     as failed_at,
  s.finished_at                                                     as recovered_at,
  extract(epoch from (s.finished_at - f.finished_at)) / 3600.0       as recovery_hours
from v_prod_deployments f
cross join lateral (
  select d2.finished_at
  from v_prod_deployments d2
  where d2.project_id = f.project_id
    and d2.environment = f.environment
    and d2.status = 'success'
    and d2.finished_at > f.finished_at
  order by d2.finished_at
  limit 1
) s
where f.status = 'failed';

-- --- jira issues --------------------------------------------------------------

create or replace view v_jira_issues with (security_invoker = true) as
select
  i.id,
  i.key,
  i.jira_id,
  i.project_key,
  i.issue_type,
  i.status,
  i.status_category,
  i.resolution,
  i.priority,
  i.summary,
  i.story_points,
  i.labels,
  i.components,
  i.epic_key,
  i.parent_key,
  i.is_bug,
  i.is_production_bug,

  i.created_at,
  i.resolved_at,
  i.first_in_progress_at,
  i.due_date,

  i.assignee_engineer_id,
  ae.full_name                                  as assignee_name,
  ae.seniority_key                              as assignee_seniority,
  i.current_sprint_id,
  sp.name                                       as sprint_name,
  sp.state                                      as sprint_state,

  -- Squad attribution order: manual override, then the sprint's board, then the
  -- assignee's squad, then the Jira project's squad.
  coalesce(
    case when i.squad_source = 'manual' then i.squad_id end,
    sp.squad_id,
    ae.squad_id,
    jp.squad_id
  )                                             as squad_id,

  extract(epoch from (i.resolved_at - i.created_at)) / 3600.0              as lead_time_hours,
  extract(epoch from (i.resolved_at - i.first_in_progress_at)) / 3600.0    as cycle_time_hours,
  (select count(*) from jira_issue_sprints js where js.issue_id = i.id)::int as sprint_count
from jira_issues i
left join engineers ae on ae.id = i.assignee_engineer_id
left join jira_sprints sp on sp.id = i.current_sprint_id
left join jira_projects jp on jp.key = i.project_key;
