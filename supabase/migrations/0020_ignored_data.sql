-- =============================================================================
-- 0020_ignored_data.sql — people and squads the app should pretend do not exist
-- =============================================================================
--
-- There is already a way to take someone out of the denominators:
-- include_in_metrics, which drops them from headcount, cohorts and per-engineer
-- rates while keeping everything they shipped. That is the right tool for an
-- engineering manager. It is the wrong tool for a row that should not be in the
-- product at all — a duplicate person record, a contractor nobody tracks, a
-- placeholder squad, an account that turned out to be machinery. For those,
-- "still counts towards their squad" is exactly the problem.
--
-- So: is_ignored. An ignored row and everything attributed to it disappears from
-- every read path — no headcount, no cohort, no squad total, no org KPI, no
-- profile page, nothing in a chart. It is reversible, and the row itself is kept:
-- deleting an engineer would only invite the next sync to recreate them, and
-- would take their identity mappings with it.
--
-- Two mechanisms, because the read paths divide in two:
--
--   1. Enumerations and counts — every one of them already filters on
--      `is_active and include_in_metrics` for engineers, or `is_active` for
--      squads. Rather than rewrite a dozen aggregate functions, a trigger holds
--      those flags false for as long as a row is ignored. That also closes the
--      hole where a HiBob sync sets is_active back to true on its next run.
--
--   2. Attribution — the views below, which is where an ignored person's merge
--      requests, reviews, commits and issues stop counting. Sprints are the one
--      aggregate that reaches a squad without passing through either, so
--      sprint_scorecards is re-created at the foot of this file.
--
-- Forcing those flags means the row loses them, so what they were is remembered
-- (pre_ignore_*) and handed back on restore. Without that, restoring a manager
-- would set include_in_metrics = true — the opposite of what their title says.
--
-- Ignoring a squad cascades to its members (recorded as ignored_source =
-- 'squad', so restoring the squad restores exactly the people it took with it
-- and leaves anyone ignored in their own right alone). The views additionally
-- drop rows *attributed* to an ignored squad, which is a different path: a merge
-- request whose author is not mapped to anyone reaches a squad through the
-- repository mapping, not through a person.
--
-- Production deployments are the one thing an ignored *person* does not remove.
-- A deploy is a fact about the system rather than about them, and dropping it
-- would quietly deflate deploy frequency and change failure rate. An ignored
-- *squad* does drop them, since that squad's numbers are going away wholesale.

-- --- columns ------------------------------------------------------------------

alter table engineers
  add column if not exists is_ignored boolean not null default false,
  add column if not exists ignored_source text not null default 'manual'
    check (ignored_source in ('manual', 'squad')),
  add column if not exists ignored_at timestamptz;

comment on column engineers.is_ignored is
  'Excluded from the app entirely: no headcount, no cohort, and nothing they authored, reviewed or was assigned counts anywhere. Reversible. Distinct from include_in_metrics, which only gates denominators.';
comment on column engineers.ignored_source is
  'manual = ignored in the admin screen; squad = ignored because their squad is. Restoring a squad only restores its own cascade.';

alter table squads
  add column if not exists is_ignored boolean not null default false,
  add column if not exists ignored_at timestamptz;

comment on column squads.is_ignored is
  'Excluded from the app entirely, along with its members and everything attributed to it. Reversible.';

-- What ignoring a row costs it, so restoring can hand it back. The flags below are
-- forced false while a row is ignored, and false is not what it was: an engineering
-- manager sits at include_in_metrics = false by title, and restoring them to true
-- would quietly move them into the per-engineer denominators they were kept out of.
alter table engineers
  add column if not exists pre_ignore_is_active boolean,
  add column if not exists pre_ignore_include_in_metrics boolean;

alter table squads
  add column if not exists pre_ignore_is_active boolean;

create index if not exists engineers_ignored_idx on engineers(is_ignored) where is_ignored;
create index if not exists squads_ignored_idx on squads(is_ignored) where is_ignored;

-- --- keep the flags the aggregates already read in step -----------------------
-- Every count of engineers in this schema is gated on is_active and
-- include_in_metrics, and every list of squads on is_active. Forcing them here
-- means an ignored row drops out of all of them without a single aggregate
-- function being rewritten, and stays out when a sync writes the row again.

create or replace function enforce_ignored_engineer()
returns trigger
language plpgsql
set search_path = public, extensions
as $fn$
declare
  was_ignored boolean := tg_op = 'UPDATE' and coalesce(old.is_ignored, false);
begin
  -- Landing in an ignored squad is the same as being ignored, and this is where a
  -- sync arrives: HiBob moves someone into a squad that is not in the product, or
  -- writes back a row it deactivated earlier. Checked on every write rather than
  -- only on the squad's own cascade, so there is no window where a re-synced
  -- member of an ignored squad counts as a head.
  if not new.is_ignored
     and new.squad_id is not null
     and exists (select 1 from squads s where s.id = new.squad_id and s.is_ignored) then
    new.is_ignored     := true;
    new.ignored_source := 'squad';
  end if;

  if new.is_ignored then
    if was_ignored then
      -- Already ignored, and this write is a sync passing through. Hold on to what
      -- the row is owed rather than remembering the false flags forced last time.
      new.pre_ignore_is_active          := old.pre_ignore_is_active;
      new.pre_ignore_include_in_metrics := old.pre_ignore_include_in_metrics;
      new.ignored_at                    := coalesce(old.ignored_at, new.ignored_at, now());
    else
      new.pre_ignore_is_active          := coalesce(
        case when tg_op = 'UPDATE' then old.is_active end, new.is_active);
      new.pre_ignore_include_in_metrics := coalesce(
        case when tg_op = 'UPDATE' then old.include_in_metrics end, new.include_in_metrics);
      new.ignored_at                    := coalesce(new.ignored_at, now());
    end if;
    new.is_active          := false;
    new.include_in_metrics := false;
  else
    if was_ignored then
      -- Restoring. The remembered flags can be stale — someone ignored in March who
      -- left in April comes back active — but the next HiBob run writes is_active
      -- and the title-derived default over them, so it corrects itself.
      new.is_active          := coalesce(old.pre_ignore_is_active, true);
      new.include_in_metrics := coalesce(old.pre_ignore_include_in_metrics, true);
    end if;
    new.pre_ignore_is_active          := null;
    new.pre_ignore_include_in_metrics := null;
    new.ignored_source                := 'manual';
    new.ignored_at                    := null;
  end if;
  return new;
end $fn$;

create or replace function enforce_ignored_squad()
returns trigger
language plpgsql
set search_path = public, extensions
as $fn$
declare
  was_ignored boolean := tg_op = 'UPDATE' and coalesce(old.is_ignored, false);
begin
  if new.is_ignored then
    if was_ignored then
      new.pre_ignore_is_active := old.pre_ignore_is_active;
      new.ignored_at           := coalesce(old.ignored_at, new.ignored_at, now());
    else
      new.pre_ignore_is_active := coalesce(
        case when tg_op = 'UPDATE' then old.is_active end, new.is_active);
      new.ignored_at           := coalesce(new.ignored_at, now());
    end if;
    new.is_active := false;
  else
    if was_ignored then
      new.is_active := coalesce(old.pre_ignore_is_active, true);
    end if;
    new.pre_ignore_is_active := null;
    new.ignored_at           := null;
  end if;
  return new;
end $fn$;

-- --- ignoring a squad takes its people with it --------------------------------
-- Recorded as ignored_source = 'squad', which is what makes the reverse safe:
-- restoring the squad restores exactly the people it took, and leaves anyone
-- ignored in their own right ignored.

create or replace function cascade_ignored_squad()
returns trigger
language plpgsql
set search_path = public, extensions
as $fn$
begin
  if new.is_ignored then
    update engineers
       set is_ignored = true, ignored_source = 'squad'
     where squad_id = new.id
       and not is_ignored;
  else
    update engineers
       set is_ignored = false
     where squad_id = new.id
       and is_ignored
       and ignored_source = 'squad';
  end if;
  return null;
end $fn$;

-- Nothing calls these directly; 0008's posture is that anon executes nothing.
revoke all on function enforce_ignored_engineer() from public, anon;
revoke all on function enforce_ignored_squad() from public, anon;
revoke all on function cascade_ignored_squad() from public, anon;

drop trigger if exists engineers_enforce_ignored on engineers;
create trigger engineers_enforce_ignored
  before insert or update on engineers
  for each row execute function enforce_ignored_engineer();

drop trigger if exists squads_enforce_ignored on squads;
create trigger squads_enforce_ignored
  before insert or update on squads
  for each row execute function enforce_ignored_squad();

-- Update only: a squad is created empty, so there is never anyone to cascade to
-- on insert, and referencing old in an insert trigger's when clause is an error.
drop trigger if exists squads_cascade_ignored on squads;
create trigger squads_cascade_ignored
  after update of is_ignored on squads
  for each row
  when (old.is_ignored is distinct from new.is_ignored)
  execute function cascade_ignored_squad();

-- --- who is ignored -----------------------------------------------------------
-- Own flag, or their squad's. The cascade keeps engineers.is_ignored in step for
-- the counts; this view is what the attribution views join, so it stays correct
-- even if a squad is ignored by a hand-written update that skips the cascade.

create or replace view v_ignored_engineers with (security_invoker = true) as
select e.id
from engineers e
left join squads s on s.id = e.squad_id
where e.is_ignored or coalesce(s.is_ignored, false);

comment on view v_ignored_engineers is
  'Engineer ids excluded from the app — ignored in their own right, or a member of an ignored squad.';

-- --- engineers ----------------------------------------------------------------
-- Same as 0004 with the ignored rows dropped.

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
  case
    when e.start_date is null then null
    else floor(extract(epoch from (now() - e.start_date::timestamptz)) / 2629800.0)::int
  end                                             as tenure_months,
  (select gi.external_handle from engineer_identities gi
    where gi.engineer_id = e.id and gi.provider = 'gitlab' limit 1) as gitlab_username,
  (select ji.external_id from engineer_identities ji
    where ji.engineer_id = e.id and ji.provider = 'jira'   limit 1) as jira_account_id
from engineers e
left join squads s on s.id = e.squad_id
left join seniority_levels sl on sl.key = e.seniority_key
where not e.is_ignored
  and coalesce(s.is_ignored, false) = false;

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

  coalesce(e.squad_id, p.squad_id)                     as squad_id,

  extract(epoch from (mr.first_review_at - mr.opened_at)) / 3600.0   as hours_to_first_review,
  extract(epoch from (mr.merged_at - mr.opened_at)) / 3600.0          as hours_open_to_merge,
  extract(epoch from (mr.merged_at - coalesce(mr.first_commit_at, mr.opened_at))) / 3600.0
                                                                      as cycle_time_hours,
  extract(epoch from (mr.merged_at - mr.first_review_at)) / 3600.0     as hours_review_to_merge,
  extract(epoch from (coalesce(mr.merged_at, mr.closed_at, now()) - mr.opened_at)) / 3600.0
                                                                      as hours_alive
from merge_requests mr
left join engineers e on e.id = mr.author_engineer_id
join gitlab_projects p on p.id = mr.project_id
where not exists (
        select 1 from v_ignored_engineers ig where ig.id = mr.author_engineer_id)
  and not exists (
        select 1 from squads hs
        where hs.id = coalesce(e.squad_id, p.squad_id) and hs.is_ignored);

-- --- review events ------------------------------------------------------------
-- Column set from 0009 (is_resolvable and the two seniority ranks), bot filter
-- from 0011. 0011 recreated this view without 0009's columns, so a database
-- rebuilt from this directory ended up with a narrower view than the deployed
-- one; this definition is the union and settles it.

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
  extract(epoch from (n.created_at - mr.opened_at)) / 3600.0 as response_hours,
  n.is_resolvable,
  coalesce(rsl.rank, 0)                      as reviewer_seniority_rank,
  coalesce(asl.rank, 0)                      as author_seniority_rank
from merge_request_notes n
join merge_requests mr on mr.id = n.merge_request_id
join gitlab_projects p on p.id = mr.project_id
left join engineers re on re.id = n.author_engineer_id
left join engineers ae on ae.id = mr.author_engineer_id
left join seniority_levels rsl on rsl.key = re.seniority_key
left join seniority_levels asl on asl.key = ae.seniority_key
where n.kind in ('comment', 'approval')
  -- A note by the MR author on their own MR is not a review.
  and (n.author_engineer_id is null or n.author_engineer_id <> mr.author_engineer_id)
  -- Automated reviewers are not collaboration.
  and not exists (
    select 1 from excluded_accounts x
    where x.provider = 'gitlab' and x.external_id = n.author_gitlab_id)
  -- Neither side of an ignored review is counted: not the reviewer's effort, not
  -- the coverage it would give the author.
  and not exists (
    select 1 from v_ignored_engineers ig where ig.id = n.author_engineer_id)
  and not exists (
    select 1 from v_ignored_engineers ig where ig.id = mr.author_engineer_id);

-- --- commits ------------------------------------------------------------------
-- 0012's definition (which added the excluded service-account addresses) plus
-- the ignored filters.

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
where not c.is_merge_commit
  and not exists (
    select 1 from excluded_accounts x
    where x.provider = 'email' and lower(x.external_id) = lower(c.author_email))
  and not exists (
    select 1 from v_ignored_engineers ig where ig.id = c.author_engineer_id)
  and not exists (
    select 1 from squads hs
    where hs.id = coalesce(e.squad_id, p.squad_id) and hs.is_ignored);

-- --- reverts ------------------------------------------------------------------

create or replace view v_reverts with (security_invoker = true) as
select
  c.id,
  c.project_id,
  c.merge_request_id,
  c.author_engineer_id,
  c.authored_at,
  c.title
from gitlab_commits c
where not c.is_merge_commit
  and c.title ~* '^\s*revert[ :"''\-]'
  and not exists (
    select 1 from v_ignored_engineers ig where ig.id = c.author_engineer_id);

-- --- merge request iterations -------------------------------------------------

create or replace view v_mr_iterations with (security_invoker = true) as
select
  mr.id                                     as merge_request_id,
  mr.author_engineer_id,
  count(c.id)                               as total_commits,
  count(c.id) filter (
    where mr.first_review_at is not null and c.authored_at > mr.first_review_at
  )                                         as commits_after_review
from merge_requests mr
left join gitlab_commits c on c.merge_request_id = mr.id
where not exists (
  select 1 from v_ignored_engineers ig where ig.id = mr.author_engineer_id)
group by mr.id, mr.author_engineer_id;

-- --- production deployments ---------------------------------------------------
-- Only the squad check here, deliberately: see the header.

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
  and d.finished_at is not null
  and not exists (
    select 1 from squads hs
    where hs.id = coalesce(e.squad_id, p.squad_id) and hs.is_ignored);

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
left join jira_projects jp on jp.key = i.project_key
where not exists (
        select 1 from v_ignored_engineers ig where ig.id = i.assignee_engineer_id)
  and not exists (
        select 1 from squads hs
        where hs.is_ignored
          and hs.id = coalesce(
            case when i.squad_source = 'manual' then i.squad_id end,
            sp.squad_id, ae.squad_id, jp.squad_id));

-- --- sprints ------------------------------------------------------------------
-- The one aggregate that reaches a squad without passing through either an
-- engineer flag or one of the views above: a sprint carries its own squad_id, so
-- an ignored squad's sprints would keep appearing on /sprints. Otherwise 0005's
-- definition unchanged.

create or replace function sprint_scorecards(p_squad_id uuid default null, p_limit int default 8)
returns table (
  sprint_id          uuid,
  sprint_name        text,
  state              text,
  squad_id           uuid,
  squad_key          text,
  start_date         timestamptz,
  end_date           timestamptz,
  complete_date      timestamptz,
  goal               text,
  committed_issues   int,
  added_issues       int,
  total_issues       int,
  completed_issues   int,
  carryover_issues   int,
  committed_points   numeric,
  completed_points   numeric,
  completion_pct     numeric,
  scope_creep_pct    numeric
)
language sql
stable
set search_path = public, extensions
as $$
with s as (
  select sp.*
  from jira_sprints sp
  where sp.state in ('active', 'closed')
    and (p_squad_id is null or sp.squad_id = p_squad_id)
    and not exists (
      select 1 from squads hs where hs.id = sp.squad_id and hs.is_ignored)
  order by coalesce(sp.start_date, sp.created_at) desc
  limit greatest(p_limit, 1)
),
agg as (
  select
    js.sprint_id,
    count(*)::int                                                     as total_issues,
    count(*) filter (where not js.added_after_start)::int              as committed_issues,
    count(*) filter (where js.added_after_start)::int                  as added_issues,
    count(*) filter (where js.completed_in_sprint)::int                as completed_issues,
    -- An issue that sat in more than one sprint was carried over.
    count(*) filter (where not js.completed_in_sprint
                       and i.status_category <> 'Done')::int           as carryover_issues,
    coalesce(sum(i.story_points) filter (where not js.added_after_start), 0) as committed_points,
    coalesce(sum(i.story_points) filter (where js.completed_in_sprint), 0)   as completed_points
  from jira_issue_sprints js
  join jira_issues i on i.id = js.issue_id
  where js.sprint_id in (select id from s)
  group by js.sprint_id
)
select
  s.id,
  s.name,
  s.state,
  s.squad_id,
  sq.key,
  s.start_date,
  s.end_date,
  s.complete_date,
  s.goal,
  coalesce(agg.committed_issues, 0),
  coalesce(agg.added_issues, 0),
  coalesce(agg.total_issues, 0),
  coalesce(agg.completed_issues, 0),
  coalesce(agg.carryover_issues, 0),
  coalesce(agg.committed_points, 0),
  coalesce(agg.completed_points, 0),
  round(100.0 * agg.completed_issues / nullif(agg.total_issues, 0)::numeric, 1),
  round(100.0 * agg.added_issues / nullif(agg.total_issues, 0)::numeric, 1)
from s
left join squads sq on sq.id = s.squad_id
left join agg on agg.sprint_id = s.id
order by coalesce(s.start_date, s.created_at) desc;
$$;

-- Replacing a function keeps its grants, so 0008's revoke from anon still stands.
