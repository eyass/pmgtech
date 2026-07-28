-- 0014 — sample size and coverage travel with every metric.
--
-- Why: a median renders identically whether it came from fifteen hundred merge requests
-- or one. In the live data the seller squad showed a 1.2h median issue cycle next to the
-- buyer squad's 23.8h — a twenty-fold difference that was one issue against two hundred
-- and ten. Nothing on the page said so.
--
-- Two rules, applied the same way at org and squad level so the two can be compared:
--   * medians and ratios are withheld (null) below SAMPLE_FLOOR = 20 observations,
--     and 5 for time-to-restore, which is scarcer by nature;
--   * rates extrapolated over a window are withheld when the underlying history does
--     not cover the window (deploy coverage below 50%).
--
-- Every guarded metric also returns its sample count, so a withheld number can be
-- explained in the UI ("4 merged MRs — too few to report") rather than showing a bare
-- dash that reads as zero or as a broken query.

-- squad_scorecards gains sample counts and deploy coverage. The return type changes, so
-- it is dropped and recreated; grants are reapplied below.
drop function if exists squad_scorecards(timestamptz, timestamptz);

create or replace function squad_scorecards(p_from timestamptz, p_to timestamptz)
returns table (
  squad_id uuid,
  squad_key text,
  squad_name text,
  colour text,
  headcount int,
  active_contributors int,
  merged_mrs int,
  open_mrs int,
  mrs_per_engineer_week numeric,
  median_cycle_hours numeric,
  p75_cycle_hours numeric,
  median_review_wait_hours numeric,
  review_coverage_pct numeric,
  median_mr_churn numeric,
  large_mr_pct numeric,
  reviews_given int,
  reviews_per_engineer_week numeric,
  commits int,
  code_churn bigint,
  prod_deploys int,
  deploys_per_week numeric,
  change_failure_pct numeric,
  mttr_hours numeric,
  issues_resolved int,
  story_points numeric,
  median_issue_cycle_hours numeric,
  bug_ratio_pct numeric,
  -- appended: what each number above rests on
  cycle_sample int,
  review_wait_sample int,
  deploy_sample int,
  mttr_sample int,
  issue_cycle_sample int,
  story_points_sample int,
  deploy_coverage_pct numeric
)
language sql
stable
set search_path to 'public', 'extensions'
as $function$
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
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to)::int          as merged_mrs,
    count(*) filter (where m.state = 'opened' and not m.is_draft)::int                 as open_mrs,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to
                       and m.distinct_reviewers > 0)::int                              as reviewed_mrs,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to
                       and m.churn > 400)::int                                         as large_mrs,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to
                       and m.cycle_time_hours is not null)::int                        as cycle_sample,
    count(*) filter (where m.merged_at >= p_from and m.merged_at < p_to
                       and m.hours_to_first_review is not null)::int                   as review_wait_sample,
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
    count(*) filter (where d.succeeded)::int     as prod_deploys,
    count(*)::int                                as finished_deploys,
    count(*) filter (where not d.succeeded)::int as failed_deploys,
    min(d.finished_at)                           as first_at,
    max(d.finished_at)                           as last_at
  from v_prod_releases d
  where d.finished_at >= p_from and d.finished_at < p_to
    and d.squad_id is not null
  group by d.squad_id
),
mttr_agg as (
  select r.squad_id,
         percentile_cont(0.5) within group (order by r.recovery_hours) as mttr_hours,
         count(*)::int                                                as recoveries
  from v_release_recovery r
  where r.failed_at >= p_from and r.failed_at < p_to
    and r.squad_id is not null
  group by r.squad_id
),
issue_agg as (
  select
    i.squad_id,
    count(*)::int                                          as issues_resolved,
    coalesce(sum(i.story_points), 0)                       as story_points,
    count(*) filter (where i.story_points is not null)::int as story_points_sample,
    count(*) filter (where i.is_bug)::int                  as bugs_resolved,
    percentile_cont(0.5) within group (order by i.cycle_time_hours)
      filter (where i.cycle_time_hours is not null)        as median_issue_cycle_hours,
    count(*) filter (where i.cycle_time_hours is not null)::int as issue_cycle_sample,
    count(distinct i.assignee_engineer_id)::int            as issue_assignees
  from v_jira_issues i
  where i.resolved_at >= p_from and i.resolved_at < p_to
    and i.squad_id is not null
  group by i.squad_id
),
dep_cover as (
  -- Share of the window between this squad's first and last production release. A
  -- weekly rate built on a two-day sliver of a ninety-day window is not a weekly rate.
  select
    dep_agg.squad_id,
    case
      when dep_agg.finished_deploys = 0 then 0::numeric
      else least(100.0, round(
        100.0 * extract(epoch from (dep_agg.last_at - dep_agg.first_at))
              / nullif(extract(epoch from (p_to - p_from)), 0)::numeric, 1))
    end as pct
  from dep_agg
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
  round((coalesce(mr_agg.merged_mrs, 0) / nullif(hc.headcount, 0)::numeric) / span.weeks::numeric, 2),

  case when coalesce(mr_agg.cycle_sample, 0) >= 20
       then round(mr_agg.median_cycle_hours::numeric, 1) end,
  case when coalesce(mr_agg.cycle_sample, 0) >= 20
       then round(mr_agg.p75_cycle_hours::numeric, 1) end,
  case when coalesce(mr_agg.review_wait_sample, 0) >= 20
       then round(mr_agg.median_review_wait_hours::numeric, 1) end,
  case when coalesce(mr_agg.merged_mrs, 0) >= 20
       then round(100.0 * mr_agg.reviewed_mrs / nullif(mr_agg.merged_mrs, 0)::numeric, 1) end,
  case when coalesce(mr_agg.merged_mrs, 0) >= 20
       then round(mr_agg.median_mr_churn::numeric, 0) end,
  case when coalesce(mr_agg.merged_mrs, 0) >= 20
       then round(100.0 * mr_agg.large_mrs / nullif(mr_agg.merged_mrs, 0)::numeric, 1) end,

  coalesce(rev_agg.reviews_given, 0),
  round((coalesce(rev_agg.reviews_given, 0) / nullif(hc.headcount, 0)::numeric) / span.weeks::numeric, 2),
  coalesce(commit_agg.commits, 0),
  coalesce(commit_agg.code_churn, 0),

  -- The count of releases is a fact and is always shown; the derived weekly rate is
  -- withheld when the history does not cover the window.
  coalesce(dep_agg.prod_deploys, 0),
  case when coalesce(dep_cover.pct, 0) >= 50
       then round(coalesce(dep_agg.prod_deploys, 0) / span.weeks::numeric, 2) end,
  case when coalesce(dep_agg.finished_deploys, 0) >= 20 and coalesce(dep_cover.pct, 0) >= 50
       then round(100.0 * dep_agg.failed_deploys / nullif(dep_agg.finished_deploys, 0)::numeric, 1) end,
  case when coalesce(mttr_agg.recoveries, 0) >= 5 and coalesce(dep_cover.pct, 0) >= 50
       then round(mttr_agg.mttr_hours::numeric, 1) end,

  coalesce(issue_agg.issues_resolved, 0),
  coalesce(issue_agg.story_points, 0),
  case when coalesce(issue_agg.issue_cycle_sample, 0) >= 20
       then round(issue_agg.median_issue_cycle_hours::numeric, 1) end,
  case when coalesce(issue_agg.issues_resolved, 0) >= 20
       then round(100.0 * issue_agg.bugs_resolved / nullif(issue_agg.issues_resolved, 0)::numeric, 1) end,

  coalesce(mr_agg.cycle_sample, 0),
  coalesce(mr_agg.review_wait_sample, 0),
  coalesce(dep_agg.finished_deploys, 0),
  coalesce(mttr_agg.recoveries, 0),
  coalesce(issue_agg.issue_cycle_sample, 0),
  coalesce(issue_agg.story_points_sample, 0),
  coalesce(dep_cover.pct, 0)
from squads s
cross join span
left join hc         on hc.squad_id = s.id
left join mr_agg     on mr_agg.squad_id = s.id
left join rev_agg    on rev_agg.squad_id = s.id
left join commit_agg on commit_agg.squad_id = s.id
left join dep_agg    on dep_agg.squad_id = s.id
left join dep_cover  on dep_cover.squad_id = s.id
left join mttr_agg   on mttr_agg.squad_id = s.id
left join issue_agg  on issue_agg.squad_id = s.id
where s.is_active
order by s.sort_order;
$function$;

revoke all on function squad_scorecards(timestamptz, timestamptz) from public;
grant execute on function squad_scorecards(timestamptz, timestamptz) to authenticated, service_role;

-- org_kpis: same guards, plus story-point coverage. Story points are populated on under
-- a tenth of issues in this instance, so a "100 points" total is a floor rather than a
-- total, and comparing it period to period compares reporting discipline, not output.
create or replace function org_kpis(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
set search_path to 'public', 'extensions'
as $function$
with s as (select * from squad_scorecards(p_from, p_to)),
weeks as (select greatest(extract(epoch from (p_to - p_from)) / 604800.0, 1.0 / 7.0) as w),
mr as (
  select
    percentile_cont(0.5) within group (order by cycle_time_hours)
      filter (where cycle_time_hours is not null)        as median_cycle_hours,
    count(*) filter (where cycle_time_hours is not null) as cycle_sample,
    percentile_cont(0.5) within group (order by hours_to_first_review)
      filter (where hours_to_first_review is not null)   as median_review_wait_hours,
    count(*) filter (where hours_to_first_review is not null) as review_wait_sample,
    count(*)                                            as merged_mrs,
    count(*) filter (where distinct_reviewers > 0)       as reviewed_mrs
  from v_merge_requests
  where merged_at >= p_from and merged_at < p_to
),
dep as (
  select
    count(*) filter (where succeeded)      as ok,
    count(*) filter (where not succeeded)  as failed,
    count(*)                               as total,
    min(finished_at)                       as first_at,
    max(finished_at)                       as last_at
  from v_prod_releases
  where finished_at >= p_from and finished_at < p_to
),
cover as (
  select case
    when dep.total = 0 then 0::numeric
    else least(100.0, round(
      100.0 * extract(epoch from (dep.last_at - dep.first_at))
            / nullif(extract(epoch from (p_to - p_from)), 0)::numeric, 1))
  end as pct
  from dep
),
rec as (
  select percentile_cont(0.5) within group (order by recovery_hours) as mttr,
         count(*) as recoveries
  from v_release_recovery
  where failed_at >= p_from and failed_at < p_to
),
iss as (
  select
    count(*)                                 as resolved,
    coalesce(sum(story_points), 0)           as points,
    count(*) filter (where story_points is not null) as points_sample,
    count(*) filter (where is_bug)           as bugs,
    percentile_cont(0.5) within group (order by cycle_time_hours)
      filter (where cycle_time_hours is not null) as median_cycle_hours,
    count(*) filter (where cycle_time_hours is not null) as cycle_sample
  from v_jira_issues
  where resolved_at >= p_from and resolved_at < p_to
),
people as (
  select
    count(*)::int as headcount,
    count(*) filter (where squad_id is null)::int as unassigned
  from engineers where is_active and include_in_metrics
),
attribution as (
  -- How much of the collected work could be tied to a person. A per-person number is
  -- only as complete as this, and it belongs on the page rather than in a query.
  select
    (select count(*) from merge_requests where merged_at >= p_from and merged_at < p_to) as mrs,
    (select count(*) from merge_requests
      where merged_at >= p_from and merged_at < p_to and author_engineer_id is not null) as mrs_attributed,
    (select count(*) from v_commits where authored_at >= p_from and authored_at < p_to) as commits,
    (select count(*) from v_commits
      where authored_at >= p_from and authored_at < p_to and author_engineer_id is not null) as commits_attributed
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

  -- Medians need a sample. Twenty is the same order as the five-merge-request floor
  -- the individual view already uses, scaled for an org-wide figure.
  'median_cycle_hours',       case when mr.cycle_sample >= 20
                                   then round(mr.median_cycle_hours::numeric, 1) end,
  'cycle_sample',             mr.cycle_sample,
  'median_review_wait_hours', case when mr.review_wait_sample >= 20
                                   then round(mr.median_review_wait_hours::numeric, 1) end,
  'review_wait_sample',       mr.review_wait_sample,
  'review_coverage_pct',      case when mr.merged_mrs >= 20
                                   then round(100.0 * mr.reviewed_mrs / nullif(mr.merged_mrs, 0)::numeric, 1) end,
  'review_coverage_sample',   mr.merged_mrs,
  'mrs_per_engineer_week',    round((mr.merged_mrs / nullif(people.headcount, 0)::numeric) / (select w from weeks), 2),

  'prod_deploys',             dep.ok,
  'deploy_sample',            dep.total,
  'deploy_coverage_pct',      cover.pct,
  'deploys_per_week',         case when cover.pct >= 50
                                   then round(dep.ok / (select w from weeks)::numeric, 2) end,
  'change_failure_pct',       case when dep.total >= 20 and cover.pct >= 50
                                   then round(100.0 * dep.failed / nullif(dep.total, 0)::numeric, 1) end,
  'mttr_hours',               case when rec.recoveries >= 5 and cover.pct >= 50
                                   then round(rec.mttr::numeric, 1) end,
  'mttr_sample',              rec.recoveries,

  'issues_resolved',          iss.resolved,
  -- Withheld below half coverage: the sum of a field only a tenth of issues carry is a
  -- lower bound, and it moves when people start estimating, not when output changes.
  'story_points',             case when iss.resolved > 0
                                    and 100.0 * iss.points_sample / iss.resolved >= 50
                                   then iss.points end,
  'story_points_sample',      iss.points_sample,
  'story_points_coverage_pct', case when iss.resolved > 0
                                   then round(100.0 * iss.points_sample / iss.resolved::numeric, 1)
                                   else 0::numeric end,
  'median_issue_cycle_hours', case when iss.cycle_sample >= 20
                                   then round(iss.median_cycle_hours::numeric, 1) end,
  'issue_cycle_sample',       iss.cycle_sample,
  'bug_ratio_pct',            case when iss.resolved >= 20
                                   then round(100.0 * iss.bugs / nullif(iss.resolved, 0)::numeric, 1) end,
  'reviews_given',            (select coalesce(sum(reviews_given), 0) from s),

  'mr_attribution_pct',       round(100.0 * attribution.mrs_attributed
                                    / nullif(attribution.mrs, 0)::numeric, 1),
  'commit_attribution_pct',   round(100.0 * attribution.commits_attributed
                                    / nullif(attribution.commits, 0)::numeric, 1),
  'unattributed_mrs',         attribution.mrs - attribution.mrs_attributed
)
from mr, dep, cover, rec, iss, people, unmapped, attribution;
$function$;

revoke all on function org_kpis(timestamptz, timestamptz) from public;
grant execute on function org_kpis(timestamptz, timestamptz) to authenticated, service_role;
