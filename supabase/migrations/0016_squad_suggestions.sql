-- 0016 — suggest a squad for engineers who have none, from where their work actually lands.
--
-- 14 active engineers had no squad, which is why squad totals stayed flat even after the
-- identity bridges attributed their merge requests: the work reached a person but the
-- person reached no team.
--
-- HiBob cannot answer this — every engineer's department here is the single value "Tech",
-- so squadKeyFromDepartment has nothing to match. Nor can the GitLab project, which is
-- the fallback the dashboard describes: this org has exactly one tracked project, a
-- monorepo that monetization, growth and seller all work in at 41/37/22%. Mapping that
-- repository to a squad would attribute most of its work to the wrong team.
--
-- What does answer it is the Jira board. Boards are mapped to squads by hand, and an
-- engineer's issues sit on the board of the team they work with. Availability of that
-- signal depended on linking Jira accounts first (see jira_bridge_candidates) — before
-- that, 0 of 570 issues resolved to a person.
--
-- Deliberately suggestions and not assignments: squad membership is an organisational
-- fact, not a derived metric, and a wrong one silently misattributes everything a person
-- does. The admin screen offers each one as a single click.

create or replace function squad_suggestions()
returns table (
  engineer_id uuid,
  full_name text,
  job_title text,
  squad_id uuid,
  squad_key text,
  squad_name text,
  issues int,
  total_issues int,
  share_pct numeric,
  mrs int
)
language sql
stable
set search_path to 'public', 'extensions'
as $function$
with unassigned as (
  select e.id, e.full_name, e.job_title
  from engineers e
  where e.is_active and e.include_in_metrics and e.squad_id is null
),
by_squad as (
  select
    i.assignee_engineer_id as eng,
    i.squad_id,
    count(*)::int          as issues
  from v_jira_issues i
  where i.assignee_engineer_id in (select id from unassigned)
    and i.squad_id is not null
  group by i.assignee_engineer_id, i.squad_id
),
totals as (
  select eng, sum(issues)::int as total from by_squad group by eng
),
ranked as (
  select
    by_squad.*,
    totals.total,
    row_number() over (partition by by_squad.eng order by by_squad.issues desc) as rn
  from by_squad
  join totals on totals.eng = by_squad.eng
),
mr_counts as (
  select m.author_engineer_id as eng, count(*)::int as mrs
  from merge_requests m
  where m.author_engineer_id in (select id from unassigned)
    and m.merged_at is not null
  group by m.author_engineer_id
)
select
  u.id,
  u.full_name,
  u.job_title,
  s.id,
  s.key,
  s.name,
  r.issues,
  r.total,
  round(100.0 * r.issues / nullif(r.total, 0)::numeric, 1),
  coalesce(mc.mrs, 0)
from ranked r
join unassigned u on u.id = r.eng
join squads s on s.id = r.squad_id
left join mr_counts mc on mc.eng = r.eng
where r.rn = 1
  -- Three issues is the same floor the identity bridges use. Below it the "dominant"
  -- board is one ticket, and a squad assignment made on one ticket is a coin toss that
  -- then silently attributes every merge request that person opens.
  and r.total >= 3
order by r.total desc, u.full_name;
$function$;

revoke all on function squad_suggestions() from public;
grant execute on function squad_suggestions() to authenticated, service_role;
