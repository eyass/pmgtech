-- =============================================================================
-- 0003_jira.sql — Jira projects, boards, sprints, issues, status history
-- =============================================================================

create table if not exists jira_projects (
  id         uuid primary key default extensions.gen_random_uuid(),
  jira_id    text not null unique,
  key        text not null unique,
  name       text not null,
  project_type text,
  squad_id   uuid references squads(id) on delete set null,
  is_tracked boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists jira_projects_updated_at on jira_projects;
create trigger jira_projects_updated_at before update on jira_projects
  for each row execute function set_updated_at();

create table if not exists jira_boards (
  id          uuid primary key default extensions.gen_random_uuid(),
  jira_id     text not null unique,
  name        text not null,
  board_type  text,                                   -- scrum | kanban
  project_key text,
  -- A board usually maps 1:1 to a squad; this is the main way sprint metrics get
  -- attributed to Team Buyer / Seller / Monetization / Growth.
  squad_id    uuid references squads(id) on delete set null,
  is_tracked  boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists jira_boards_squad_idx on jira_boards(squad_id);

create table if not exists jira_sprints (
  id           uuid primary key default extensions.gen_random_uuid(),
  jira_id      text not null unique,
  board_id     uuid references jira_boards(id) on delete set null,
  name         text not null,
  state        text not null,                         -- future | active | closed
  goal         text,
  start_date   timestamptz,
  end_date     timestamptz,
  complete_date timestamptz,
  squad_id     uuid references squads(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists jira_sprints_squad_idx on jira_sprints(squad_id, start_date desc);
create index if not exists jira_sprints_state_idx on jira_sprints(state);

drop trigger if exists jira_sprints_updated_at on jira_sprints;
create trigger jira_sprints_updated_at before update on jira_sprints
  for each row execute function set_updated_at();

-- --- issues -------------------------------------------------------------------

create table if not exists jira_issues (
  id                  uuid primary key default extensions.gen_random_uuid(),
  jira_id             text not null unique,
  key                 text not null unique,
  project_key         text not null,

  issue_type          text,
  status              text,
  -- Jira's status category: To Do | In Progress | Done. Stable across the
  -- per-project workflow renaming that makes raw status names useless.
  status_category     text,
  resolution          text,
  priority            text,
  summary             text,
  story_points        numeric,

  assignee_engineer_id uuid references engineers(id) on delete set null,
  assignee_jira_id     text,
  reporter_engineer_id uuid references engineers(id) on delete set null,
  reporter_jira_id     text,

  created_at          timestamptz not null,
  updated_at_remote   timestamptz,
  resolved_at         timestamptz,
  due_date            date,
  -- Derived from the changelog: when the issue first entered an In Progress
  -- status. Cycle time is measured from here, lead time from created_at.
  first_in_progress_at timestamptz,

  parent_key          text,
  epic_key            text,
  labels              text[] not null default '{}',
  components          text[] not null default '{}',

  current_sprint_id   uuid references jira_sprints(id) on delete set null,
  -- Squad override: normally derived from the board/sprint or the assignee, but
  -- can be pinned by hand for cross-team tickets.
  squad_id            uuid references squads(id) on delete set null,
  squad_source        text not null default 'derived'
                        check (squad_source in ('derived','manual')),

  is_bug              boolean not null default false,
  -- Bugs found in production are the change-failure signal on the Jira side and
  -- complement GitLab's failed-deployment ratio.
  is_production_bug   boolean not null default false,

  synced_at           timestamptz not null default now()
);

create index if not exists jira_issues_assignee_idx on jira_issues(assignee_engineer_id);
create index if not exists jira_issues_resolved_idx on jira_issues(resolved_at desc) where resolved_at is not null;
create index if not exists jira_issues_created_idx on jira_issues(created_at desc);
create index if not exists jira_issues_sprint_idx on jira_issues(current_sprint_id);
create index if not exists jira_issues_project_idx on jira_issues(project_key);
create index if not exists jira_issues_status_cat_idx on jira_issues(status_category);
create index if not exists jira_issues_epic_idx on jira_issues(epic_key);

-- --- issue <-> sprint history -------------------------------------------------
-- An issue can appear in several sprints. Rows here are what make carryover and
-- mid-sprint scope creep measurable.

create table if not exists jira_issue_sprints (
  issue_id           uuid not null references jira_issues(id) on delete cascade,
  sprint_id          uuid not null references jira_sprints(id) on delete cascade,
  -- When the issue was added to this sprint (from the changelog when available,
  -- otherwise the sprint start). added_after_start drives the scope-creep number.
  added_at           timestamptz,
  added_after_start  boolean not null default false,
  removed_at         timestamptz,
  completed_in_sprint boolean not null default false,
  primary key (issue_id, sprint_id)
);

create index if not exists jira_issue_sprints_sprint_idx on jira_issue_sprints(sprint_id);

-- --- status transition history ------------------------------------------------

create table if not exists jira_status_transitions (
  id            uuid primary key default extensions.gen_random_uuid(),
  issue_id      uuid not null references jira_issues(id) on delete cascade,
  jira_history_id text,
  from_status   text,
  to_status     text,
  from_category text,
  to_category   text,
  author_engineer_id uuid references engineers(id) on delete set null,
  author_jira_id text,
  created_at    timestamptz not null,
  unique (issue_id, jira_history_id)
);

create index if not exists jira_transitions_issue_idx on jira_status_transitions(issue_id, created_at);

-- Links Jira tickets to the MRs that implemented them (populated from the MR
-- title/branch/description scan in the GitLab sync).
create table if not exists issue_merge_requests (
  issue_id         uuid not null references jira_issues(id) on delete cascade,
  merge_request_id uuid not null references merge_requests(id) on delete cascade,
  primary key (issue_id, merge_request_id)
);
