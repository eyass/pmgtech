-- 0018 — a band only reads 'above' or 'below' when the gap is big enough to matter.
--
-- percent_rank alone answers the wrong question. It always finds a top and a bottom
-- quartile, even in a cohort where everybody is within an hour of each other: five
-- seniors with median cycle times of 19, 20, 20, 21 and 22 hours produce one 'above'
-- and one 'below' band, and the 22-hour engineer walks into a one-to-one being asked
-- what is slowing them down. Nothing is. They are two hours off the middle of a
-- four-hour spread, and the tool manufactured a conversation out of noise.
--
-- So the rank now has to clear an absolute materiality gate before it is allowed to
-- speak. Below the gate the band reads 'typical', which is what the number actually
-- says. The thresholds:
--
--   cycle time      25% away from the cohort median, relative — a 25% swing on a
--                   two-day median is a real half-day, on a two-hour median it is
--                   half an hour and worth nobody's time
--   review coverage 10 percentage points, absolute — coverage is already a
--                   percentage, so a relative test would compound
--   reviews given   2 reviews AND 25% — the two-review floor stops small integers
--                   (1 vs 2 is +100%) from reading as a gap, the 25% stops a large
--                   cohort median making a genuine 12-vs-20 difference invisible
--
-- These are gates on top of the existing guardrails, never a replacement: the sample
-- and cohort minimums still suppress a band outright, and a suppressed band stays
-- 'insufficient'. The order of the cases matters — 'insufficient' means we cannot
-- see, 'typical' means we can see and there is nothing there.
--
-- Shape is deliberately left alone. It compares against the cohort median directly
-- rather than a rank, and it is descriptive rather than evaluative — 'Shipper' is not
-- a worse thing to be than 'Anchor', so a near-median engineer landing on one side or
-- the other costs them nothing.

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
-- engineer is meaningless, so it is not offered. The medians here are what the
-- materiality gates measure distance from, which is why every banded metric now
-- needs one and not just the two the shape uses.
cohort as (
  select
    seniority_key,
    count(*)::int as peers,
    percentile_cont(0.5) within group (order by merged_mrs::double precision)    as med_merged,
    percentile_cont(0.5) within group (order by reviews_given::double precision) as med_reviews,
    percentile_cont(0.5) within group (order by median_cycle_hours)              as med_cycle,
    percentile_cont(0.5) within group (order by review_coverage_received_pct::double precision)
      as med_coverage
  from base
  group by seniority_key
),
ranked as (
  select
    b.*,
    c.peers,
    c.med_merged,
    c.med_reviews,
    c.med_cycle,
    c.med_coverage,
    -- Enough of a footprint for a band to mean anything.
    (b.merged_mrs >= 5 or b.issues_resolved >= 5) as sample_ok,
    percent_rank() over (partition by b.seniority_key order by b.median_cycle_hours desc) as cycle_pr,
    percent_rank() over (partition by b.seniority_key order by b.reviews_given)           as reviews_pr,
    percent_rank() over (partition by b.seniority_key order by b.review_coverage_received_pct) as coverage_pr,
    -- Is this engineer far enough from the middle of their cohort for the rank to be
    -- worth saying out loud? Each gate is computed here rather than inline in the
    -- CASEs below so the threshold sits next to the median it is measured against.
    --
    -- Relative, because cycle time has no natural scale: 25% of a slow cohort's
    -- median is hours, 25% of a fast one's is minutes, and both are the right size
    -- of difference to notice. Guarded against a zero median so a cohort that merges
    -- within the hour cannot divide by zero.
    (
      c.med_cycle is not null and c.med_cycle > 0 and b.median_cycle_hours is not null
      and abs(b.median_cycle_hours - c.med_cycle) / c.med_cycle >= 0.25
    ) as cycle_material,
    -- Absolute, because coverage is already a percentage. 10 points is roughly one
    -- unreviewed merge request in ten — visible in a diff, not in the noise.
    (
      c.med_coverage is not null and b.review_coverage_received_pct is not null
      and abs(b.review_coverage_received_pct - c.med_coverage) >= 10
    ) as coverage_material,
    -- Both tests, because review counts are small integers at one end and not at the
    -- other. The floor of 2 stops 1-vs-2 reading as a doubling; the 25% stops a
    -- cohort median of 16 making 12-vs-20 look like the same nothing.
    (
      c.med_reviews is not null
      and abs(b.reviews_given - c.med_reviews) >= 2
      and abs(b.reviews_given - c.med_reviews) >= 0.25 * greatest(c.med_reviews, 1)
    ) as reviews_material
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

  -- 'insufficient' before 'typical' in every one of these: they are different
  -- statements. 'insufficient' says the tool cannot see enough to have an opinion,
  -- 'typical' says it can see and the engineer sits with their cohort. Collapsing
  -- the two would hide missing data behind a reassuring word.
  case
    when not r.sample_ok or r.peers < 3 or r.median_cycle_hours is null then 'insufficient'
    when not r.cycle_material then 'typical'
    when r.cycle_pr >= 0.75 then 'above'
    when r.cycle_pr <= 0.25 then 'below'
    else 'typical'
  end,
  case
    when not r.sample_ok or r.peers < 3 or r.review_coverage_received_pct is null then 'insufficient'
    when not r.coverage_material then 'typical'
    when r.coverage_pr >= 0.75 then 'above'
    when r.coverage_pr <= 0.25 then 'below'
    else 'typical'
  end,
  case
    when r.peers < 3 then 'insufficient'
    when not r.reviews_material then 'typical'
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
    -- Shape is cohort-relative, so it needs the same guard the bands use: with
    -- fewer than three peers the median is effectively the person themselves,
    -- and any shape would just be measuring them against their own numbers.
    when r.peers < 3 then 'No cohort'
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
