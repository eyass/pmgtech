-- 0015 — bridge GitLab accounts to engineers through the commits inside their MRs.
--
-- GitLab reports a merge request's author as a numeric user id and, for most accounts in
-- this instance, no email — so email-based identity resolution has nothing to work with
-- and 46% of merged merge requests are attributed to nobody. The commits inside those
-- merge requests do carry author emails, and those emails do match engineers.
--
-- This function only gathers the evidence. Whether it is strong enough to act on is
-- decided in src/lib/sync/matching.ts, where it can be unit-tested against the real
-- cases — including the account whose merge requests are 63% authored by an unrelated
-- person, which aggregate commit share cannot distinguish from a genuine link.
--
-- The measure returned is per-merge-request dominance, not total commit share: for each
-- merge request, which email authored the most commits in it, and in how many of the
-- account's merge requests did the same email win. One large merge request full of
-- somebody else's commits moves total share a long way and this measure barely at all.

create or replace function commit_bridge_candidates()
returns table (
  provider text,
  external_id text,
  display_name text,
  handle text,
  email text,
  mrs_won int,
  mrs int,
  commits int,
  engineer_id uuid,
  engineer_name text
)
language sql
stable
set search_path to 'public', 'extensions'
as $function$
with per_mr as (
  select
    mr.author_gitlab_id                        as gid,
    mr.id                                      as mr_id,
    lower(trim(c.author_email))                as email,
    count(*)                                   as commits,
    row_number() over (
      partition by mr.author_gitlab_id, mr.id
      order by count(*) desc, lower(trim(c.author_email))
    )                                          as rn
  from merge_requests mr
  join gitlab_commits c on c.merge_request_id = mr.id
  where mr.author_engineer_id is null
    and mr.author_gitlab_id is not null
    and c.author_email is not null
    and trim(c.author_email) <> ''
    and not c.is_merge_commit
    -- An account already mapped by hand or by a previous run has nothing to bridge.
    and not exists (
      select 1 from engineer_identities ei
      where ei.provider = 'gitlab' and ei.external_id = mr.author_gitlab_id
    )
  group by mr.author_gitlab_id, mr.id, lower(trim(c.author_email))
),
totals as (
  select gid, count(distinct mr_id)::int as mrs from per_mr group by gid
),
wins as (
  select gid, email, count(*)::int as mrs_won, sum(commits)::int as commits
  from per_mr
  where rn = 1
  group by gid, email
),
ranked as (
  select
    wins.*,
    totals.mrs,
    row_number() over (partition by wins.gid order by wins.mrs_won desc, wins.commits desc) as rn
  from wins
  join totals on totals.gid = wins.gid
)
select
  'gitlab'::text,
  r.gid,
  u.display_name,
  u.external_handle,
  r.email,
  r.mrs_won,
  r.mrs,
  r.commits,
  e.id,
  e.full_name
from ranked r
left join unmatched_identities u
  on u.provider = 'gitlab' and u.external_id = r.gid
left join engineers e
  on lower(e.email) = r.email
where r.rn = 1
order by r.mrs desc, r.mrs_won desc;
$function$;

revoke all on function commit_bridge_candidates() from public;
grant execute on function commit_bridge_candidates() to authenticated, service_role;

-- The same shape for Jira, where the evidence has to be different.
--
-- Atlassian will not hand out an address for an API token at all: the REST
-- /user/email endpoint answers "Requestor must be a whitelisted app (not a user)", and
-- emailAddress is omitted from every user object. So all 39 Jira accounts in this
-- instance arrive with a display name and nothing else, and 0 of 570 issues attribute to
-- a person — which also means no per-person board signal, and so no way to suggest a
-- squad from Jira activity.
--
-- The evidence that is available: merge requests record the Jira keys in their branch and
-- title, and merge-request authors are now resolved. So if the issues assigned to a Jira
-- account are consistently referenced by merge requests one engineer opened, that account
-- is that engineer. Names then corroborate, exactly as in the commit bridge — they never
-- decide on their own.
create or replace function jira_bridge_candidates()
returns table (
  provider text,
  external_id text,
  display_name text,
  handle text,
  mrs_won int,
  mrs int,
  engineer_id uuid,
  engineer_name text
)
language sql
stable
set search_path to 'public', 'extensions'
as $function$
with pairs as (
  select
    i.assignee_jira_id       as account,
    m.author_engineer_id     as eng,
    count(distinct i.key)::int as issues
  from merge_requests m
  join jira_issues i on i.key = any(m.jira_keys)
  where m.author_engineer_id is not null
    and i.assignee_jira_id is not null
    and not exists (
      select 1 from engineer_identities ei
      where ei.provider = 'jira' and ei.external_id = i.assignee_jira_id
    )
  group by i.assignee_jira_id, m.author_engineer_id
),
totals as (
  select account, sum(issues)::int as issues from pairs group by account
),
ranked as (
  select pairs.*, totals.issues as total,
         row_number() over (partition by pairs.account order by pairs.issues desc) as rn
  from pairs join totals on totals.account = pairs.account
)
select
  'jira'::text,
  r.account,
  u.display_name,
  u.external_handle,
  r.issues,
  r.total,
  e.id,
  e.full_name
from ranked r
join engineers e on e.id = r.eng
left join unmatched_identities u on u.provider = 'jira' and u.external_id = r.account
where r.rn = 1
order by r.total desc;
$function$;

revoke all on function jira_bridge_candidates() from public;
grant execute on function jira_bridge_candidates() to authenticated, service_role;
