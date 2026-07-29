-- =============================================================================
-- 0009_performance_framework.sql — four-dimension measurement framework
-- =============================================================================
-- Telemetry describes, humans evaluate.
--
-- Team level: the four dimensions are legitimate performance metrics. Manage on
-- them.
--
-- Individual level: they are conversation inputs, not scores. Three guardrails
-- are built into the SQL rather than left to the UI, so they cannot be bypassed
-- by a future caller:
--   1. Percentiles are computed within a seniority level, never org-wide.
--   2. Percentiles are suppressed below MIN_SAMPLE merged MRs or MIN_PEERS peers.
--   3. No composite individual score exists to be ranked on.
--
-- Every output metric is paired with a counter-metric, so optimising one alone
-- shows up as a regression in the other:
--   throughput      ↔ review coverage received, revert involvement
--   speed           ↔ MR size, change failure rate
--   reviews given   ↔ review depth (rubber-stamping is visible)
--   points closed   ↔ unplanned-work share

-- --- reference: the four dimensions -------------------------------------------

create table if not exists performance_dimensions (
  key               text primary key,
  name              text not null,
  team_question     text not null,
  individual_question text not null,
  what_it_sees      text not null,
  what_it_cannot_see text not null,
  sort_order        int not null
);

insert into performance_dimensions
  (key, name, team_question, individual_question, what_it_sees, what_it_cannot_see, sort_order)
values
  ('flow', 'Flow',
   'Does work move, or does it queue?',
   'Is this person''s work getting stuck, and where?',
   'Cycle time, flow efficiency (working vs waiting), batch size, work in progress.',
   'Whether the work was worth doing, or whether slowness came from the person, the review queue, the CI pipeline or an external dependency. A low flow number is usually a system property, not a person property.',
   1),
  ('quality', 'Quality',
   'Does what we ship stay working?',
   'Is this person shipping safely?',
   'Change failure rate, time to restore, review coverage, revert involvement, merge-request size discipline.',
   'Defects nobody reported, quality of tests, whether risk was taken deliberately and well. Someone doing the hardest, least certain work will look worse here than someone doing routine work.',
   2),
  ('collaboration', 'Collaboration',
   'Is knowledge shared, or concentrated in a few heads?',
   'Are they multiplying the people around them?',
   'Reviews given, review response latency, review depth, how many different colleagues they review for, review of more-junior engineers.',
   'Pairing, design conversations, incident handling, mentoring outside code review, and everything said in Slack or in person. Most senior-engineer leverage is invisible here.',
   3),
  ('impact', 'Impact',
   'Was the work worth building?',
   'Did this person work on the right things, and move the needle?',
   'Work-type mix, unplanned-work share, sprint predictability, epic progress. Context only.',
   'Almost everything that matters. Telemetry cannot see business value, judgement, technical direction, or a hard problem avoided. This dimension is assessed by a human and recorded in engineer_assessments; the numbers here are context for that conversation, not a substitute for it.',
   4)
on conflict (key) do update set
  name = excluded.name,
  team_question = excluded.team_question,
  individual_question = excluded.individual_question,
  what_it_sees = excluded.what_it_sees,
  what_it_cannot_see = excluded.what_it_cannot_see,
  sort_order = excluded.sort_order;

-- --- the human half -----------------------------------------------------------
-- Structured so a review cycle is evidence-based and consistent rather than
-- recency-biased. Deliberately requires evidence text alongside any rating.

create table if not exists engineer_assessments (
  id            uuid primary key default extensions.gen_random_uuid(),
  engineer_id   uuid not null references engineers(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  dimension_key text not null references performance_dimensions(key),
  -- 1 below expectations for level … 5 well above. Nullable so a dimension can
  -- be left unrated rather than forced to a number.
  rating        int check (rating between 1 and 5),
  evidence      text,
  assessed_by   text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (engineer_id, period_start, period_end, dimension_key)
);

create index if not exists assessments_engineer_idx
  on engineer_assessments(engineer_id, period_end desc);

drop trigger if exists engineer_assessments_updated_at on engineer_assessments;
create trigger engineer_assessments_updated_at before update on engineer_assessments
  for each row execute function set_updated_at();

create table if not exists assessment_summaries (
  id            uuid primary key default extensions.gen_random_uuid(),
  engineer_id   uuid not null references engineers(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  headline      text,
  strengths     text,
  growth        text,
  assessed_by   text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (engineer_id, period_start, period_end)
);

drop trigger if exists assessment_summaries_updated_at on assessment_summaries;
create trigger assessment_summaries_updated_at before update on assessment_summaries
  for each row execute function set_updated_at();

-- Assessments are personnel data. RLS on with no policy for authenticated, so
-- only the service role reads them and the app gates on admin status.
alter table performance_dimensions enable row level security;
alter table engineer_assessments   enable row level security;
alter table assessment_summaries   enable row level security;

drop policy if exists performance_dimensions_viewer_select on performance_dimensions;
create policy performance_dimensions_viewer_select on performance_dimensions
  for select to authenticated using (is_app_viewer());

-- --- derived signal views -----------------------------------------------------

-- Review iterations: commits pushed after the first review arrived. Reads as
-- collaboration working (reviewer asked, author fixed), not as a defect count —
-- which is why it is reported and never scored.
create or replace view v_mr_iterations with (security_invoker = true) as
select
  mr.id                                                             as merge_request_id,
  mr.author_engineer_id,
  count(c.id)                                                       as total_commits,
  count(c.id) filter (
    where mr.first_review_at is not null and c.authored_at > mr.first_review_at
  )                                                                 as commits_after_review
from merge_requests mr
left join gitlab_commits c on c.merge_request_id = mr.id
group by mr.id, mr.author_engineer_id;

-- Reverts, by commit-message convention. A proxy, not ground truth: a revert can
-- be someone else's mistake being cleaned up, so this is a prompt to look rather
-- than a mark against anyone.
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
  and c.title ~* '^\s*revert[ :"''\-]';

-- Flow efficiency: time an issue spent actually being worked versus total
-- elapsed. The single most useful number for distinguishing "the team is slow"
-- from "the team is waiting", and it is a system property, not a person one.
create or replace view v_issue_flow with (security_invoker = true) as
with transitions as (
  select
    ts.issue_id,
    ts.created_at,
    ts.to_category,
    lead(ts.created_at) over (partition by ts.issue_id order by ts.created_at) as next_at
  from jira_status_transitions ts
),
bounded as (
  select
    t.issue_id,
    t.to_category,
    t.created_at,
    -- The final transition runs until the issue resolved, or until now if open.
    coalesce(t.next_at, i.resolved_at, now()) as ends_at
  from transitions t
  join jira_issues i on i.id = t.issue_id
)
select
  b.issue_id,
  round((sum(extract(epoch from (b.ends_at - b.created_at)))
          filter (where b.to_category = 'In Progress') / 3600.0)::numeric, 2) as active_hours,
  round((sum(extract(epoch from (b.ends_at - b.created_at))) / 3600.0)::numeric, 2) as tracked_hours
from bounded b
where b.ends_at > b.created_at
group by b.issue_id;

-- Add seniority ranks to review events so "reviewed someone more junior" — the
-- closest telemetry gets to mentoring — becomes computable.
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
  and (n.author_engineer_id is null or n.author_engineer_id <> mr.author_engineer_id);
