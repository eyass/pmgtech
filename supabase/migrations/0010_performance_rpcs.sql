-- =============================================================================
-- 0010_performance_rpcs.sql — four-dimension aggregation for teams and people
-- =============================================================================

-- --- team health: one row per squad, all four dimensions ----------------------

create or replace function team_health(p_from timestamptz, p_to timestamptz)
returns table (
  squad_id                 uuid,
  squad_key                text,
  squad_name               text,
  colour                   text,
  headcount                int,
  -- flow
  median_cycle_hours       numeric,
  p75_cycle_hours          numeric,
  flow_efficiency_pct      numeric,
  median_mr_churn          numeric,
  wip_per_engineer         numeric,
  deploys_per_week         numeric,
  -- quality
  change_failure_pct       numeric,
  mttr_hours               numeric,
  review_coverage_pct      numeric,
  reverts                  int,
  production_bugs          int,
  -- collaboration
  reviews_per_engineer_week numeric,
  review_gini              numeric,
  cross_squad_review_pct   numeric,
  median_review_response_hours numeric,
  median_review_depth_chars numeric,
  -- impact (context only)
  unplanned_work_pct       numeric,
  sprint_completion_pct    numeric,
  story_points             numeric,
  issues_resolved          int
)
language sql
stable
set search_path = public, extensions
as $fn$
with
span as (
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
    percentile_cont(0.5) within group (order by m.cycle_time_hours)
      filter (where m.merged_at >= p_from and m.merged_at < p_to
                and m.cycle_time_hours is not null)                as median_cycle_hours,
    percentile_cont(0.75) within group (order by m.cycle_time_hours)
      filter (where m.merged_at >= p_from and m.merged_at < p_to
                and m.cycle_time_hours is not null)                as p75_cycle_hours,
    percentile_cont(0.5) within group (order by m.churn::double precision)
      filter (where m.merged_at >= p_from and m.merged_at < p_to)   as median_mr_churn,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to)::int as merged_mrs,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to
                       and m.distinct_reviewers > 0)::int           as reviewed_mrs,
    count(*) filter (where m.state = 'opened' and not m.is_draft)::int as open_mrs
  from v_merge_requests m
  where m.squad_id is not null
  group by m.squad_id
),
-- Flow efficiency: working time over elapsed time, across the squad's resolved
-- issues. Low numbers mean queueing, which is a system problem.
flow_agg as (
  select
    i.squad_id,
    sum(f.active_hours)  as active_hours,
    sum(f.tracked_hours) as tracked_hours
  from v_jira_issues i
  join v_issue_flow f on f.issue_id = i.id
  where i.resolved_at >= p_from and i.resolved_at < p_to
    and i.squad_id is not null
  group by i.squad_id
),
dep_agg as (
  select
    d.squad_id,
    count(*) filter (where d.succeeded)::int     as prod_deploys,
    count(*)::int                                as finished_deploys,
    count(*) filter (where not d.succeeded)::int as failed_deploys
  from v_prod_deployments d
  where d.finished_at >= p_from and d.finished_at < p_to and d.squad_id is not null
  group by d.squad_id
),
mttr_agg as (
  select r.squad_id, percentile_cont(0.5) within group (order by r.recovery_hours) as mttr_hours
  from v_deployment_recovery r
  where r.failed_at >= p_from and r.failed_at < p_to and r.squad_id is not null
  group by r.squad_id
),
revert_agg as (
  select coalesce(e.squad_id, p.squad_id) as squad_id, count(*)::int as reverts
  from v_reverts v
  join gitlab_projects p on p.id = v.project_id
  left join engineers e on e.id = v.author_engineer_id
  where v.authored_at >= p_from and v.authored_at < p_to
  group by 1
),
review_per_person as (
  select
    e.squad_id,
    e.id as engineer_id,
    count(r.id)::int as reviews
  from engineers e
  left join v_review_events r
    on r.reviewer_engineer_id = e.id
   and r.created_at >= p_from and r.created_at < p_to
  where e.is_active and e.include_in_metrics and e.squad_id is not null
  group by e.squad_id, e.id
),
-- Gini of review load. 0 means reviews are shared evenly, 1 means one person
-- carries everything. Engineers who reviewed nothing are included on purpose.
gini_ranked as (
  select
    squad_id,
    reviews,
    row_number() over (partition by squad_id order by reviews)  as i,
    count(*)     over (partition by squad_id)                   as n,
    sum(reviews) over (partition by squad_id)                   as total
  from review_per_person
),
gini_agg as (
  select
    squad_id,
    case when total > 0 and n > 1
      then round(((2.0 * sum(i::numeric * reviews) - (n + 1) * total) / (n * total))::numeric, 3)
    end as review_gini
  from gini_ranked
  group by squad_id, n, total
),
review_agg as (
  select
    r.reviewer_squad_id as squad_id,
    count(*)::int as reviews_given,
    count(*) filter (where r.reviewer_squad_id <> r.author_squad_id)::int as cross_squad_reviews,
    percentile_cont(0.5) within group (order by r.response_hours)
      filter (where r.response_hours is not null)                as median_response_hours,
    percentile_cont(0.5) within group (order by r.body_length::double precision)
      filter (where r.kind = 'comment' and r.body_length > 0)     as median_depth_chars
  from v_review_events r
  where r.created_at >= p_from and r.created_at < p_to
    and r.reviewer_squad_id is not null
  group by r.reviewer_squad_id
),
issue_agg as (
  select
    i.squad_id,
    count(*)::int                                   as issues_resolved,
    coalesce(sum(i.story_points), 0)                as story_points,
    count(*) filter (where i.is_bug)::int           as bugs,
    count(*) filter (where i.is_production_bug)::int as production_bugs
  from v_jira_issues i
  where i.resolved_at >= p_from and i.resolved_at < p_to and i.squad_id is not null
  group by i.squad_id
),
sprint_agg as (
  select s.squad_id, avg(s.completion_pct) as sprint_completion_pct
  from sprint_scorecards(null, 50) s
  where s.state = 'closed' and s.squad_id is not null
  group by s.squad_id
)
select
  sq.id,
  sq.key,
  sq.name,
  sq.colour,
  coalesce(hc.headcount, 0),
  round(mr_agg.median_cycle_hours::numeric, 1),
  round(mr_agg.p75_cycle_hours::numeric, 1),
  round(100.0 * flow_agg.active_hours / nullif(flow_agg.tracked_hours, 0), 1),
  round(mr_agg.median_mr_churn::numeric, 0),
  round(mr_agg.open_mrs / nullif(hc.headcount, 0)::numeric, 2),
  round(coalesce(dep_agg.prod_deploys, 0) / span.weeks::numeric, 2),
  round(100.0 * dep_agg.failed_deploys / nullif(dep_agg.finished_deploys, 0)::numeric, 1),
  round(mttr_agg.mttr_hours::numeric, 1),
  round(100.0 * mr_agg.reviewed_mrs / nullif(mr_agg.merged_mrs, 0)::numeric, 1),
  coalesce(revert_agg.reverts, 0),
  coalesce(issue_agg.production_bugs, 0),
  round((coalesce(review_agg.reviews_given, 0) / nullif(hc.headcount, 0)::numeric) / span.weeks::numeric, 2),
  gini_agg.review_gini,
  round(100.0 * review_agg.cross_squad_reviews / nullif(review_agg.reviews_given, 0)::numeric, 1),
  round(review_agg.median_response_hours::numeric, 1),
  round(review_agg.median_depth_chars::numeric, 0),
  round(100.0 * issue_agg.bugs / nullif(issue_agg.issues_resolved, 0)::numeric, 1),
  round(sprint_agg.sprint_completion_pct::numeric, 1),
  coalesce(issue_agg.story_points, 0),
  coalesce(issue_agg.issues_resolved, 0)
from squads sq
cross join span
left join hc         on hc.squad_id = sq.id
left join mr_agg     on mr_agg.squad_id = sq.id
left join flow_agg   on flow_agg.squad_id = sq.id
left join dep_agg    on dep_agg.squad_id = sq.id
left join mttr_agg   on mttr_agg.squad_id = sq.id
left join revert_agg on revert_agg.squad_id = sq.id
left join gini_agg   on gini_agg.squad_id = sq.id
left join review_agg on review_agg.squad_id = sq.id
left join issue_agg  on issue_agg.squad_id = sq.id
left join sprint_agg on sprint_agg.squad_id = sq.id
where sq.is_active
order by sq.sort_order;
$fn$;

-- --- individual profiles ------------------------------------------------------
-- Signals plus a within-level band. No composite score is produced, and bands
-- are suppressed when the sample is too small to mean anything.

create or replace function engineer_profiles(
  p_from        timestamptz,
  p_to          timestamptz,
  p_squad_id    uuid default null,
  p_engineer_id uuid default null
)
returns table (
  engineer_id              uuid,
  full_name                text,
  job_title                text,
  seniority_key            text,
  seniority_label          text,
  tenure_months            int,
  squad_id                 uuid,
  squad_key                text,
  squad_name               text,
  -- volume context, deliberately not scored
  merged_mrs               int,
  commits                  int,
  issues_resolved          int,
  story_points             numeric,
  -- flow
  median_cycle_hours       numeric,
  median_mr_churn          numeric,
  open_mrs                 int,
  flow_efficiency_pct      numeric,
  -- quality
  review_coverage_received_pct numeric,
  large_mr_pct             numeric,
  reverts_authored         int,
  median_review_iterations numeric,
  -- collaboration
  reviews_given            int,
  distinct_authors_reviewed int,
  median_review_response_hours numeric,
  median_review_depth_chars numeric,
  threads_raised           int,
  mentoring_reviews        int,
  -- interpretation
  peers_at_level           int,
  sample_sufficient        boolean,
  flow_band                text,
  quality_band             text,
  collaboration_band       text,
  shape                    text,
  last_active_at           timestamptz
)
language sql
stable
set search_path = public, extensions
as $fn$
with
base as (
  select
    e.id,
    e.display_name,
    e.job_title,
    e.seniority_key,
    e.seniority_label,
    e.tenure_months,
    e.squad_id,
    e.squad_key,
    e.squad_name,

    coalesce(mr.merged_mrs, 0)                as merged_mrs,
    coalesce(cm.commits, 0)                   as commits,
    coalesce(iss.issues_resolved, 0)          as issues_resolved,
    coalesce(iss.story_points, 0)             as story_points,

    mr.median_cycle_hours,
    mr.median_mr_churn,
    coalesce(mr.open_mrs, 0)                  as open_mrs,
    round(100.0 * fl.active_hours / nullif(fl.tracked_hours, 0), 1) as flow_efficiency_pct,

    round(100.0 * mr.reviewed_mrs / nullif(mr.merged_mrs, 0)::numeric, 1) as review_coverage_received_pct,
    round(100.0 * mr.large_mrs / nullif(mr.merged_mrs, 0)::numeric, 1)    as large_mr_pct,
    coalesce(rv.reverts, 0)                   as reverts_authored,
    it.median_iterations,

    coalesce(rg.reviews_given, 0)             as reviews_given,
    coalesce(rg.distinct_authors, 0)          as distinct_authors_reviewed,
    rg.median_response_hours,
    rg.median_depth_chars,
    coalesce(rg.threads_raised, 0)            as threads_raised,
    coalesce(rg.mentoring_reviews, 0)         as mentoring_reviews,

    greatest(mr.last_merge_at, rg.last_review_at, cm.last_commit_at, iss.last_resolve_at) as last_active_at
  from v_engineers e

  left join (
    select
      author_engineer_id as eid,
      count(*) filter (where merged_at >= p_from and merged_at < p_to)::int as merged_mrs,
      count(*) filter (where state = 'opened' and not is_draft)::int        as open_mrs,
      count(*) filter (where merged_at >= p_from and merged_at < p_to
                         and distinct_reviewers > 0)::int                   as reviewed_mrs,
      count(*) filter (where merged_at >= p_from and merged_at < p_to
                         and churn > 400)::int                              as large_mrs,
      percentile_cont(0.5) within group (order by cycle_time_hours)
        filter (where merged_at >= p_from and merged_at < p_to
                  and cycle_time_hours is not null)                         as median_cycle_hours,
      percentile_cont(0.5) within group (order by churn::double precision)
        filter (where merged_at >= p_from and merged_at < p_to)             as median_mr_churn,
      max(merged_at) filter (where merged_at < p_to)                        as last_merge_at
    from v_merge_requests
    where author_engineer_id is not null
    group by 1
  ) mr on mr.eid = e.id

  left join (
    select author_engineer_id as eid, count(*)::int as commits, max(authored_at) as last_commit_at
    from v_commits
    where authored_at >= p_from and authored_at < p_to and author_engineer_id is not null
    group by 1
  ) cm on cm.eid = e.id

  left join (
    select
      i.assignee_engineer_id as eid,
      count(*)::int as issues_resolved,
      coalesce(sum(i.story_points), 0) as story_points,
      max(i.resolved_at) as last_resolve_at
    from v_jira_issues i
    where i.resolved_at >= p_from and i.resolved_at < p_to
      and i.assignee_engineer_id is not null
    group by 1
  ) iss on iss.eid = e.id

  left join (
    select i.assignee_engineer_id as eid,
           sum(f.active_hours) as active_hours,
           sum(f.tracked_hours) as tracked_hours
    from v_jira_issues i
    join v_issue_flow f on f.issue_id = i.id
    where i.resolved_at >= p_from and i.resolved_at < p_to
      and i.assignee_engineer_id is not null
    group by 1
  ) fl on fl.eid = e.id

  left join (
    select author_engineer_id as eid, count(*)::int as reverts
    from v_reverts
    where authored_at >= p_from and authored_at < p_to and author_engineer_id is not null
    group by 1
  ) rv on rv.eid = e.id

  left join (
    select
      mi.author_engineer_id as eid,
      percentile_cont(0.5) within group (order by mi.commits_after_review::double precision) as median_iterations
    from v_mr_iterations mi
    join merge_requests m on m.id = mi.merge_request_id
    where m.merged_at >= p_from and m.merged_at < p_to and mi.author_engineer_id is not null
    group by 1
  ) it on it.eid = e.id

  left join (
    select
      r.reviewer_engineer_id as eid,
      count(*)::int as reviews_given,
      count(distinct r.author_engineer_id)::int as distinct_authors,
      count(*) filter (where r.is_resolvable)::int as threads_raised,
      -- Reviewing someone more junior: the closest telemetry gets to mentoring.
      count(*) filter (where r.author_seniority_rank > 0
                         and r.author_seniority_rank < r.reviewer_seniority_rank)::int as mentoring_reviews,
      percentile_cont(0.5) within group (order by r.response_hours)
        filter (where r.response_hours is not null) as median_response_hours,
      percentile_cont(0.5) within group (order by r.body_length::double precision)
        filter (where r.kind = 'comment' and r.body_length > 0) as median_depth_chars,
      max(r.created_at) as last_review_at
    from v_review_events r
    where r.created_at >= p_from and r.created_at < p_to
      and r.reviewer_engineer_id is not null
    group by 1
  ) rg on rg.eid = e.id

  where e.is_active and e.include_in_metrics
),
-- Cohort = others at the same seniority level. Comparing a junior to a staff
-- engineer is meaningless, so it is not offered.
cohort as (
  select
    seniority_key,
    count(*)::int as peers,
    percentile_cont(0.5) within group (order by merged_mrs::double precision)    as med_merged,
    percentile_cont(0.5) within group (order by reviews_given::double precision) as med_reviews
  from base
  group by seniority_key
),
ranked as (
  select
    b.*,
    c.peers,
    c.med_merged,
    c.med_reviews,
    -- Enough of a footprint for a band to mean anything.
    (b.merged_mrs >= 5 or b.issues_resolved >= 5) as sample_ok,
    percent_rank() over (partition by b.seniority_key order by b.median_cycle_hours desc) as cycle_pr,
    percent_rank() over (partition by b.seniority_key order by b.reviews_given)           as reviews_pr,
    percent_rank() over (partition by b.seniority_key order by b.review_coverage_received_pct) as coverage_pr
  from base b
  join cohort c on c.seniority_key = b.seniority_key
)
select
  r.id,
  r.display_name,
  r.job_title,
  r.seniority_key,
  r.seniority_label,
  r.tenure_months,
  r.squad_id,
  r.squad_key,
  r.squad_name,

  r.merged_mrs,
  r.commits,
  r.issues_resolved,
  r.story_points,

  round(r.median_cycle_hours::numeric, 1),
  round(r.median_mr_churn::numeric, 0),
  r.open_mrs,
  r.flow_efficiency_pct,

  r.review_coverage_received_pct,
  r.large_mr_pct,
  r.reverts_authored,
  round(r.median_iterations::numeric, 1),

  r.reviews_given,
  r.distinct_authors_reviewed,
  round(r.median_response_hours::numeric, 1),
  round(r.median_depth_chars::numeric, 0),
  r.threads_raised,
  r.mentoring_reviews,

  r.peers,
  r.sample_ok,

  case
    when not r.sample_ok or r.peers < 3 or r.median_cycle_hours is null then 'insufficient'
    when r.cycle_pr >= 0.75 then 'above'
    when r.cycle_pr <= 0.25 then 'below'
    else 'typical'
  end,
  case
    when not r.sample_ok or r.peers < 3 or r.review_coverage_received_pct is null then 'insufficient'
    when r.coverage_pr >= 0.75 then 'above'
    when r.coverage_pr <= 0.25 then 'below'
    else 'typical'
  end,
  case
    when r.peers < 3 then 'insufficient'
    when r.reviews_pr >= 0.75 then 'above'
    when r.reviews_pr <= 0.25 then 'below'
    else 'typical'
  end,

  -- Descriptive shape, not a grade. 'Quiet in telemetry' is the important one:
  -- it means this tool cannot see the work, which is not the same as no work.
  -- greatest(median, 1) matters: in a cohort where the median review count is
  -- zero, a plain >= comparison would credit someone who reviewed nothing as a
  -- Multiplier. You have to have actually done the thing.
  case
    when r.merged_mrs    >= greatest(r.med_merged, 1)
     and r.reviews_given >= greatest(r.med_reviews, 1) then 'Anchor'
    when r.merged_mrs    >= greatest(r.med_merged, 1)
     and r.reviews_given <  greatest(r.med_reviews, 1) then 'Shipper'
    when r.merged_mrs    <  greatest(r.med_merged, 1)
     and r.reviews_given >= greatest(r.med_reviews, 1) then 'Multiplier'
    else 'Quiet in telemetry'
  end,

  r.last_active_at
from ranked r
where (p_squad_id is null or r.squad_id = p_squad_id)
  and (p_engineer_id is null or r.id = p_engineer_id)
order by r.display_name;
$fn$;

-- --- knowledge concentration --------------------------------------------------
-- Bus factor by repository. A repo whose top author wrote most of it is a
-- staffing risk regardless of how well the squad's other numbers read.

create or replace function knowledge_concentration(p_from timestamptz, p_to timestamptz)
returns table (
  project_id            uuid,
  project_name          text,
  squad_id              uuid,
  squad_key             text,
  contributors          int,
  commits               int,
  top_author_name       text,
  top_author_share_pct  numeric
)
language sql
stable
set search_path = public, extensions
as $fn$
-- Squad comes from the repository, not from v_commits.squad_id — the latter
-- falls back to the author's squad, which would vary per contributor and make
-- this attribution meaningless.
with per_author as (
  select c.project_id, c.author_engineer_id, c.author_name, count(*)::int as commits
  from v_commits c
  where c.authored_at >= p_from and c.authored_at < p_to
    and c.author_engineer_id is not null
  group by 1, 2, 3
),
totals as (
  select project_id, sum(commits)::int as commits, count(*)::int as contributors
  from per_author group by project_id
),
top_author as (
  select distinct on (project_id) project_id, author_name, commits
  from per_author
  order by project_id, commits desc, author_name
)
select
  gp.id,
  gp.name,
  gp.squad_id,
  s.key,
  t.contributors,
  t.commits,
  ta.author_name,
  round(100.0 * ta.commits / nullif(t.commits, 0)::numeric, 1)
from totals t
join gitlab_projects gp on gp.id = t.project_id
join top_author ta on ta.project_id = t.project_id
left join squads s on s.id = gp.squad_id
where t.commits >= 10
order by 8 desc;
$fn$;

-- --- grants -------------------------------------------------------------------

revoke all on function team_health(timestamptz, timestamptz) from public, anon;
revoke all on function engineer_profiles(timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function knowledge_concentration(timestamptz, timestamptz) from public, anon;

grant execute on function team_health(timestamptz, timestamptz)                       to authenticated, service_role;
grant execute on function engineer_profiles(timestamptz, timestamptz, uuid, uuid)     to authenticated, service_role;
grant execute on function knowledge_concentration(timestamptz, timestamptz)           to authenticated, service_role;
