-- =============================================================================
-- 0005_metrics.sql — aggregation RPCs consumed directly by the dashboard
-- =============================================================================
-- Every function is STABLE and pushes the work into Postgres so a page render is
-- one round trip per widget rather than a fan-out of row fetches.

-- --- squad scorecards ---------------------------------------------------------

create or replace function squad_scorecards(p_from timestamptz, p_to timestamptz)
returns table (
  squad_id                 uuid,
  squad_key                text,
  squad_name               text,
  colour                   text,
  headcount                int,
  active_contributors      int,
  merged_mrs               int,
  open_mrs                 int,
  mrs_per_engineer_week    numeric,
  median_cycle_hours       numeric,
  p75_cycle_hours          numeric,
  median_review_wait_hours numeric,
  review_coverage_pct      numeric,
  median_mr_churn          numeric,
  large_mr_pct             numeric,
  reviews_given            int,
  reviews_per_engineer_week numeric,
  commits                  int,
  code_churn               bigint,
  prod_deploys             int,
  deploys_per_week         numeric,
  change_failure_pct       numeric,
  mttr_hours               numeric,
  issues_resolved          int,
  story_points             numeric,
  median_issue_cycle_hours numeric,
  bug_ratio_pct            numeric
)
language sql
stable
set search_path = public, extensions
as $$
with
span as (
  -- Guard against a zero-length range so per-week rates never divide by zero.
  select greatest(extract(epoch from (p_to - p_from)) / 604800.0, 1.0 / 7.0) as weeks
),
hc as (
  select e.squad_id, count(*)::int as headcount
  from engineers e
  where e.is_active and e.include_in_metrics and e.squad_id is not null
  group by e.squad_id
),
mr_agg as (
  select
    m.squad_id,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to)::int          as merged_mrs,
    count(*) filter (where m.state = 'opened' and not m.is_draft)::int                 as open_mrs,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to
                       and m.distinct_reviewers > 0)::int                              as reviewed_mrs,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to
                       and m.churn > 400)::int                                         as large_mrs,
    percentile_cont(0.5) within group (order by m.cycle_time_hours)
      filter (where m.merged_at >= p_from and m.merged_at < p_to
                and m.cycle_time_hours is not null)                                    as median_cycle_hours,
    percentile_cont(0.75) within group (order by m.cycle_time_hours)
      filter (where m.merged_at >= p_from and m.merged_at < p_to
                and m.cycle_time_hours is not null)                                    as p75_cycle_hours,
    percentile_cont(0.5) within group (order by m.hours_to_first_review)
      filter (where m.merged_at >= p_from and m.merged_at < p_to
                and m.hours_to_first_review is not null)                               as median_review_wait_hours,
    percentile_cont(0.5) within group (order by m.churn::double precision)
      filter (where m.merged_at >= p_from and m.merged_at < p_to)                      as median_mr_churn
  from v_merge_requests m
  where m.squad_id is not null
  group by m.squad_id
),
rev_agg as (
  select r.reviewer_squad_id as squad_id, count(*)::int as reviews_given
  from v_review_events r
  where r.created_at >= p_from and r.created_at < p_to
    and r.reviewer_squad_id is not null
  group by r.reviewer_squad_id
),
commit_agg as (
  select
    c.squad_id,
    count(*)::int                                as commits,
    coalesce(sum(c.churn), 0)::bigint            as code_churn,
    count(distinct c.author_engineer_id)::int    as commit_authors
  from v_commits c
  where c.authored_at >= p_from and c.authored_at < p_to
    and c.squad_id is not null
  group by c.squad_id
),
dep_agg as (
  select
    d.squad_id,
    count(*) filter (where d.succeeded)::int as prod_deploys,
    count(*)::int                            as finished_deploys,
    count(*) filter (where not d.succeeded)::int as failed_deploys
  from v_prod_deployments d
  where d.finished_at >= p_from and d.finished_at < p_to
    and d.squad_id is not null
  group by d.squad_id
),
mttr_agg as (
  select r.squad_id,
         percentile_cont(0.5) within group (order by r.recovery_hours) as mttr_hours
  from v_deployment_recovery r
  where r.failed_at >= p_from and r.failed_at < p_to
    and r.squad_id is not null
  group by r.squad_id
),
issue_agg as (
  select
    i.squad_id,
    count(*)::int                                          as issues_resolved,
    coalesce(sum(i.story_points), 0)                       as story_points,
    count(*) filter (where i.is_bug)::int                   as bugs_resolved,
    percentile_cont(0.5) within group (order by i.cycle_time_hours)
      filter (where i.cycle_time_hours is not null)         as median_issue_cycle_hours,
    count(distinct i.assignee_engineer_id)::int             as issue_assignees
  from v_jira_issues i
  where i.resolved_at >= p_from and i.resolved_at < p_to
    and i.squad_id is not null
  group by i.squad_id
)
select
  s.id,
  s.key,
  s.name,
  s.colour,
  coalesce(hc.headcount, 0),
  greatest(coalesce(commit_agg.commit_authors, 0), coalesce(issue_agg.issue_assignees, 0)),
  coalesce(mr_agg.merged_mrs, 0),
  coalesce(mr_agg.open_mrs, 0),
  round((coalesce(mr_agg.merged_mrs, 0) / nullif(hc.headcount, 0)::numeric)
          / span.weeks::numeric, 2),
  round(mr_agg.median_cycle_hours::numeric, 1),
  round(mr_agg.p75_cycle_hours::numeric, 1),
  round(mr_agg.median_review_wait_hours::numeric, 1),
  round(100.0 * mr_agg.reviewed_mrs / nullif(mr_agg.merged_mrs, 0)::numeric, 1),
  round(mr_agg.median_mr_churn::numeric, 0),
  round(100.0 * mr_agg.large_mrs / nullif(mr_agg.merged_mrs, 0)::numeric, 1),
  coalesce(rev_agg.reviews_given, 0),
  round((coalesce(rev_agg.reviews_given, 0) / nullif(hc.headcount, 0)::numeric)
          / span.weeks::numeric, 2),
  coalesce(commit_agg.commits, 0),
  coalesce(commit_agg.code_churn, 0),
  coalesce(dep_agg.prod_deploys, 0),
  round(coalesce(dep_agg.prod_deploys, 0) / span.weeks::numeric, 2),
  round(100.0 * dep_agg.failed_deploys / nullif(dep_agg.finished_deploys, 0)::numeric, 1),
  round(mttr_agg.mttr_hours::numeric, 1),
  coalesce(issue_agg.issues_resolved, 0),
  coalesce(issue_agg.story_points, 0),
  round(issue_agg.median_issue_cycle_hours::numeric, 1),
  round(100.0 * issue_agg.bugs_resolved / nullif(issue_agg.issues_resolved, 0)::numeric, 1)
from squads s
cross join span
left join hc         on hc.squad_id = s.id
left join mr_agg     on mr_agg.squad_id = s.id
left join rev_agg    on rev_agg.squad_id = s.id
left join commit_agg on commit_agg.squad_id = s.id
left join dep_agg    on dep_agg.squad_id = s.id
left join mttr_agg   on mttr_agg.squad_id = s.id
left join issue_agg  on issue_agg.squad_id = s.id
where s.is_active
order by s.sort_order;
$$;

-- --- org-level KPIs -----------------------------------------------------------

create or replace function org_kpis(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
with s as (select * from squad_scorecards(p_from, p_to)),
weeks as (select greatest(extract(epoch from (p_to - p_from)) / 604800.0, 1.0 / 7.0) as w),
mr as (
  select
    percentile_cont(0.5) within group (order by cycle_time_hours)
      filter (where cycle_time_hours is not null)        as median_cycle_hours,
    percentile_cont(0.5) within group (order by hours_to_first_review)
      filter (where hours_to_first_review is not null)   as median_review_wait_hours,
    count(*)                                            as merged_mrs,
    count(*) filter (where distinct_reviewers > 0)       as reviewed_mrs
  from v_merge_requests
  where merged_at >= p_from and merged_at < p_to
),
dep as (
  select
    count(*) filter (where succeeded)      as ok,
    count(*) filter (where not succeeded)  as failed,
    count(*)                               as total
  from v_prod_deployments
  where finished_at >= p_from and finished_at < p_to
),
rec as (
  select percentile_cont(0.5) within group (order by recovery_hours) as mttr
  from v_deployment_recovery
  where failed_at >= p_from and failed_at < p_to
),
iss as (
  select
    count(*)                                 as resolved,
    coalesce(sum(story_points), 0)            as points,
    count(*) filter (where is_bug)           as bugs,
    percentile_cont(0.5) within group (order by cycle_time_hours)
      filter (where cycle_time_hours is not null) as median_cycle_hours
  from v_jira_issues
  where resolved_at >= p_from and resolved_at < p_to
),
people as (
  select
    count(*)::int as headcount,
    count(*) filter (where squad_id is null)::int as unassigned
  from engineers where is_active and include_in_metrics
),
unmapped as (
  select count(*)::int as n from unmatched_identities where not dismissed
)
select jsonb_build_object(
  'headcount',                people.headcount,
  'unassigned_engineers',     people.unassigned,
  'unmapped_identities',      unmapped.n,
  'merged_mrs',               mr.merged_mrs,
  'open_mrs',                 (select coalesce(sum(open_mrs), 0) from s),
  'median_cycle_hours',       round(mr.median_cycle_hours::numeric, 1),
  'median_review_wait_hours', round(mr.median_review_wait_hours::numeric, 1),
  'review_coverage_pct',      round(100.0 * mr.reviewed_mrs / nullif(mr.merged_mrs, 0)::numeric, 1),
  'mrs_per_engineer_week',    round((mr.merged_mrs / nullif(people.headcount, 0)::numeric)
                                      / (select w from weeks), 2),
  'prod_deploys',             dep.ok,
  'deploys_per_week',         round(dep.ok / (select w from weeks)::numeric, 2),
  'change_failure_pct',       round(100.0 * dep.failed / nullif(dep.total, 0)::numeric, 1),
  'mttr_hours',               round(rec.mttr::numeric, 1),
  'issues_resolved',          iss.resolved,
  'story_points',             iss.points,
  'median_issue_cycle_hours', round(iss.median_cycle_hours::numeric, 1),
  'bug_ratio_pct',            round(100.0 * iss.bugs / nullif(iss.resolved, 0)::numeric, 1),
  'reviews_given',            (select coalesce(sum(reviews_given), 0) from s)
)
from mr, dep, rec, iss, people, unmapped;
$$;

-- --- trend series -------------------------------------------------------------

create or replace function delivery_trend(
  p_from   timestamptz,
  p_to     timestamptz,
  p_bucket text default 'week',
  p_squad_id uuid default null
)
returns table (
  bucket             timestamptz,
  squad_id           uuid,
  squad_key          text,
  merged_mrs         int,
  issues_resolved    int,
  prod_deploys       int,
  median_cycle_hours numeric,
  commits            int
)
language sql
stable
set search_path = public, extensions
as $$
with
-- Only day/week/month are allowed; anything else falls back to week so a bad
-- query string can never reach date_trunc as arbitrary text.
b as (select case when p_bucket in ('day','week','month') then p_bucket else 'week' end as unit),
grid as (
  select generate_series(
    date_trunc((select unit from b), p_from),
    date_trunc((select unit from b), p_to),
    case (select unit from b)
      when 'day' then interval '1 day'
      when 'month' then interval '1 month'
      else interval '1 week'
    end
  ) as bucket
),
sq as (
  select id, key from squads
  where is_active and (p_squad_id is null or id = p_squad_id)
),
mrs as (
  select date_trunc((select unit from b), merged_at) as bucket, squad_id,
         count(*)::int as merged_mrs,
         percentile_cont(0.5) within group (order by cycle_time_hours)
           filter (where cycle_time_hours is not null) as median_cycle_hours
  from v_merge_requests
  where merged_at >= p_from and merged_at < p_to and squad_id is not null
  group by 1, 2
),
iss as (
  select date_trunc((select unit from b), resolved_at) as bucket, squad_id,
         count(*)::int as issues_resolved
  from v_jira_issues
  where resolved_at >= p_from and resolved_at < p_to and squad_id is not null
  group by 1, 2
),
dep as (
  select date_trunc((select unit from b), finished_at) as bucket, squad_id,
         count(*)::int as prod_deploys
  from v_prod_deployments
  where finished_at >= p_from and finished_at < p_to and squad_id is not null and succeeded
  group by 1, 2
),
cmt as (
  select date_trunc((select unit from b), authored_at) as bucket, squad_id,
         count(*)::int as commits
  from v_commits
  where authored_at >= p_from and authored_at < p_to and squad_id is not null
  group by 1, 2
)
select
  grid.bucket,
  sq.id,
  sq.key,
  coalesce(mrs.merged_mrs, 0),
  coalesce(iss.issues_resolved, 0),
  coalesce(dep.prod_deploys, 0),
  round(mrs.median_cycle_hours::numeric, 1),
  coalesce(cmt.commits, 0)
from grid
cross join sq
left join mrs on mrs.bucket = grid.bucket and mrs.squad_id = sq.id
left join iss on iss.bucket = grid.bucket and iss.squad_id = sq.id
left join dep on dep.bucket = grid.bucket and dep.squad_id = sq.id
left join cmt on cmt.bucket = grid.bucket and cmt.squad_id = sq.id
order by grid.bucket, sq.key;
$$;

-- --- engineer scorecards ------------------------------------------------------

create or replace function engineer_scorecards(
  p_from     timestamptz,
  p_to       timestamptz,
  p_squad_id uuid default null
)
returns table (
  engineer_id              uuid,
  full_name                text,
  avatar_url               text,
  job_title                text,
  seniority_key            text,
  seniority_label          text,
  seniority_rank           int,
  tenure_months            int,
  squad_id                 uuid,
  squad_key                text,
  squad_name               text,
  merged_mrs               int,
  open_mrs                 int,
  median_cycle_hours       numeric,
  median_mr_churn          numeric,
  code_churn               bigint,
  commits                  int,
  reviews_given            int,
  reviews_received         int,
  median_review_response_hours numeric,
  distinct_authors_reviewed int,
  issues_resolved          int,
  story_points             numeric,
  median_issue_cycle_hours numeric,
  bugs_resolved            int,
  last_active_at           timestamptz
)
language sql
stable
set search_path = public, extensions
as $$
with
base as (
  select * from v_engineers
  where is_active and include_in_metrics
    and (p_squad_id is null or squad_id = p_squad_id)
),
mr as (
  select
    author_engineer_id as eid,
    count(*) filter (where merged_at >= p_from and merged_at < p_to)::int as merged_mrs,
    count(*) filter (where state = 'opened' and not is_draft)::int        as open_mrs,
    percentile_cont(0.5) within group (order by cycle_time_hours)
      filter (where merged_at >= p_from and merged_at < p_to
                and cycle_time_hours is not null)                        as median_cycle_hours,
    percentile_cont(0.5) within group (order by churn::double precision)
      filter (where merged_at >= p_from and merged_at < p_to)            as median_mr_churn,
    max(merged_at) filter (where merged_at < p_to)                       as last_merge_at
  from v_merge_requests
  where author_engineer_id is not null
  group by 1
),
rev_given as (
  select reviewer_engineer_id as eid,
         count(*)::int as reviews_given,
         count(distinct author_engineer_id)::int as distinct_authors_reviewed,
         percentile_cont(0.5) within group (order by response_hours)
           filter (where response_hours is not null) as median_response_hours,
         max(created_at) as last_review_at
  from v_review_events
  where created_at >= p_from and created_at < p_to
    and reviewer_engineer_id is not null
  group by 1
),
rev_recv as (
  select author_engineer_id as eid, count(*)::int as reviews_received
  from v_review_events
  where created_at >= p_from and created_at < p_to
    and author_engineer_id is not null
  group by 1
),
cmt as (
  select author_engineer_id as eid,
         count(*)::int as commits,
         coalesce(sum(churn), 0)::bigint as code_churn,
         max(authored_at) as last_commit_at
  from v_commits
  where authored_at >= p_from and authored_at < p_to
    and author_engineer_id is not null
  group by 1
),
iss as (
  select assignee_engineer_id as eid,
         count(*)::int as issues_resolved,
         coalesce(sum(story_points), 0) as story_points,
         count(*) filter (where is_bug)::int as bugs_resolved,
         percentile_cont(0.5) within group (order by cycle_time_hours)
           filter (where cycle_time_hours is not null) as median_issue_cycle_hours,
         max(resolved_at) as last_resolve_at
  from v_jira_issues
  where resolved_at >= p_from and resolved_at < p_to
    and assignee_engineer_id is not null
  group by 1
)
select
  base.id,
  base.display_name,
  base.avatar_url,
  base.job_title,
  base.seniority_key,
  base.seniority_label,
  base.seniority_rank,
  base.tenure_months,
  base.squad_id,
  base.squad_key,
  base.squad_name,
  coalesce(mr.merged_mrs, 0),
  coalesce(mr.open_mrs, 0),
  round(mr.median_cycle_hours::numeric, 1),
  round(mr.median_mr_churn::numeric, 0),
  coalesce(cmt.code_churn, 0),
  coalesce(cmt.commits, 0),
  coalesce(rev_given.reviews_given, 0),
  coalesce(rev_recv.reviews_received, 0),
  round(rev_given.median_response_hours::numeric, 1),
  coalesce(rev_given.distinct_authors_reviewed, 0),
  coalesce(iss.issues_resolved, 0),
  coalesce(iss.story_points, 0),
  round(iss.median_issue_cycle_hours::numeric, 1),
  coalesce(iss.bugs_resolved, 0),
  greatest(mr.last_merge_at, rev_given.last_review_at, cmt.last_commit_at, iss.last_resolve_at)
from base
left join mr        on mr.eid = base.id
left join rev_given on rev_given.eid = base.id
left join rev_recv  on rev_recv.eid = base.id
left join cmt       on cmt.eid = base.id
left join iss       on iss.eid = base.id
order by coalesce(mr.merged_mrs, 0) + coalesce(iss.issues_resolved, 0) desc, base.display_name;
$$;

-- --- seniority benchmark ------------------------------------------------------
-- Answers "are people delivering in line with their level" without ranking
-- individuals: aggregates per rung of the ladder, suppressing rungs with fewer
-- than two people so a single engineer is never singled out.

create or replace function seniority_benchmark(p_from timestamptz, p_to timestamptz, p_squad_id uuid default null)
returns table (
  seniority_key    text,
  seniority_label  text,
  seniority_rank   int,
  engineers        int,
  median_merged_mrs        numeric,
  median_cycle_hours       numeric,
  median_reviews_given     numeric,
  median_issues_resolved   numeric,
  median_mr_churn          numeric
)
language sql
stable
set search_path = public, extensions
as $$
with e as (select * from engineer_scorecards(p_from, p_to, p_squad_id))
select
  sl.key,
  sl.label,
  sl.rank,
  count(*)::int,
  percentile_cont(0.5) within group (order by e.merged_mrs::double precision)::numeric,
  round(percentile_cont(0.5) within group (order by e.median_cycle_hours)::numeric, 1),
  percentile_cont(0.5) within group (order by e.reviews_given::double precision)::numeric,
  percentile_cont(0.5) within group (order by e.issues_resolved::double precision)::numeric,
  round(percentile_cont(0.5) within group (order by e.median_mr_churn)::numeric, 0)
from e
join seniority_levels sl on sl.key = e.seniority_key
group by sl.key, sl.label, sl.rank
having count(*) > 1
order by sl.rank desc;
$$;

-- --- review network -----------------------------------------------------------
-- Who reviews for whom, rolled up to squad level. Reveals review silos and
-- single points of failure.

create or replace function review_network(p_from timestamptz, p_to timestamptz)
returns table (
  reviewer_squad_id uuid,
  reviewer_squad    text,
  author_squad_id   uuid,
  author_squad      text,
  reviews           int
)
language sql
stable
set search_path = public, extensions
as $$
select
  r.reviewer_squad_id,
  rs.name,
  r.author_squad_id,
  aus.name,
  count(*)::int
from v_review_events r
join squads rs  on rs.id  = r.reviewer_squad_id
join squads aus on aus.id = r.author_squad_id
where r.created_at >= p_from and r.created_at < p_to
group by 1, 2, 3, 4
order by 5 desc;
$$;

-- --- sprint scorecards --------------------------------------------------------

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

-- --- work type mix ------------------------------------------------------------
-- Where the effort actually went: feature vs bug vs chore vs support, per squad.

create or replace function work_type_mix(p_from timestamptz, p_to timestamptz)
returns table (
  squad_id   uuid,
  squad_key  text,
  issue_type text,
  issues     int,
  points     numeric,
  share_pct  numeric
)
language sql
stable
set search_path = public, extensions
as $$
with x as (
  select i.squad_id, coalesce(i.issue_type, 'Unknown') as issue_type,
         count(*)::int as issues,
         coalesce(sum(i.story_points), 0) as points
  from v_jira_issues i
  where i.resolved_at >= p_from and i.resolved_at < p_to
    and i.squad_id is not null
  group by 1, 2
)
select
  x.squad_id,
  s.key,
  x.issue_type,
  x.issues,
  x.points,
  round(100.0 * x.issues / nullif(sum(x.issues) over (partition by x.squad_id), 0)::numeric, 1)
from x
join squads s on s.id = x.squad_id
order by s.sort_order, x.issues desc;
$$;

-- --- attention list -----------------------------------------------------------
-- Open MRs that need a human: stale, unreviewed, or oversized. This is the
-- action-oriented counterpart to the trend charts.

create or replace function mr_attention_list(p_squad_id uuid default null, p_limit int default 25)
returns table (
  merge_request_id uuid,
  title            text,
  web_url          text,
  project_name     text,
  author_name      text,
  squad_id         uuid,
  squad_key        text,
  opened_at        timestamptz,
  age_hours        numeric,
  churn            int,
  distinct_reviewers int,
  notes_count      int,
  reason           text
)
language sql
stable
set search_path = public, extensions
as $$
select
  m.id,
  m.title,
  m.web_url,
  m.project_name,
  coalesce(m.author_name, 'Unmapped author'),
  m.squad_id,
  s.key,
  m.opened_at,
  round(m.hours_alive::numeric, 1),
  m.churn,
  m.distinct_reviewers,
  m.notes_count,
  case
    when m.distinct_reviewers = 0 and m.hours_alive > 24 then 'No review after 24h'
    when m.hours_alive > 168                             then 'Open more than 7 days'
    when m.churn > 800                                   then 'Very large changeset'
    else 'Needs attention'
  end
from v_merge_requests m
left join squads s on s.id = m.squad_id
where m.state = 'opened'
  and not m.is_draft
  and (p_squad_id is null or m.squad_id = p_squad_id)
  and ((m.distinct_reviewers = 0 and m.hours_alive > 24)
       or m.hours_alive > 168
       or m.churn > 800)
order by m.hours_alive desc
limit greatest(p_limit, 1);
$$;
