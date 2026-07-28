-- =============================================================================
-- 0002_gitlab.sql — GitLab projects, merge requests, review activity, delivery
-- =============================================================================

create table if not exists gitlab_projects (
  id                  uuid primary key default extensions.gen_random_uuid(),
  gitlab_id           bigint not null unique,
  name                text not null,
  path_with_namespace text not null,
  web_url             text,
  default_branch      text,
  archived            boolean not null default false,
  -- Repos can be owned by a squad. Used as the squad fallback for activity whose
  -- author we cannot resolve to an engineer.
  squad_id            uuid references squads(id) on delete set null,
  -- Only tracked projects are synced. Lets you point the app at a subset of a
  -- large GitLab group without burning API quota on everything else.
  is_tracked          boolean not null default true,
  last_activity_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists gitlab_projects_tracked_idx on gitlab_projects(is_tracked) where is_tracked;
create index if not exists gitlab_projects_squad_idx on gitlab_projects(squad_id);

drop trigger if exists gitlab_projects_updated_at on gitlab_projects;
create trigger gitlab_projects_updated_at before update on gitlab_projects
  for each row execute function set_updated_at();

-- --- merge requests -----------------------------------------------------------

create table if not exists merge_requests (
  id                 uuid primary key default extensions.gen_random_uuid(),
  gitlab_id          bigint not null unique,          -- global MR id
  iid                bigint not null,                 -- per-project number
  project_id         uuid not null references gitlab_projects(id) on delete cascade,

  title              text,
  description_length int,
  state              text not null,                   -- opened | merged | closed | locked
  is_draft           boolean not null default false,
  source_branch      text,
  target_branch      text,
  web_url            text,

  author_engineer_id uuid references engineers(id) on delete set null,
  author_gitlab_id   text,
  merged_by_engineer_id uuid references engineers(id) on delete set null,

  opened_at          timestamptz not null,
  updated_at_remote  timestamptz,
  merged_at          timestamptz,
  closed_at          timestamptz,
  first_commit_at    timestamptz,                     -- earliest commit on the MR
  first_review_at    timestamptz,                     -- first note/approval by someone else
  first_approval_at  timestamptz,

  additions          int not null default 0,
  deletions          int not null default 0,
  changed_files      int not null default 0,
  commits_count      int not null default 0,
  notes_count        int not null default 0,           -- discussion notes, bots excluded
  approvals_count    int not null default 0,
  distinct_reviewers int not null default 0,

  labels             text[] not null default '{}',
  -- Set when the MR description or branch references a Jira key, letting us tie
  -- code back to the ticket without relying on the Jira dev-status API.
  jira_keys          text[] not null default '{}',

  synced_at          timestamptz not null default now(),
  unique (project_id, iid)
);

create index if not exists mr_project_idx        on merge_requests(project_id);
create index if not exists mr_author_idx         on merge_requests(author_engineer_id);
create index if not exists mr_merged_at_idx      on merge_requests(merged_at desc) where merged_at is not null;
create index if not exists mr_opened_at_idx      on merge_requests(opened_at desc);
create index if not exists mr_state_idx          on merge_requests(state);
create index if not exists mr_jira_keys_idx      on merge_requests using gin (jira_keys);

-- --- review activity ----------------------------------------------------------
-- One row per review-ish event on an MR: a discussion note or an approval. This
-- is what powers "who is actually reviewing" and review-load balance.

create table if not exists merge_request_notes (
  id                 uuid primary key default extensions.gen_random_uuid(),
  gitlab_id          bigint not null unique,
  merge_request_id   uuid not null references merge_requests(id) on delete cascade,
  author_engineer_id uuid references engineers(id) on delete set null,
  author_gitlab_id   text,
  kind               text not null default 'comment'
                       check (kind in ('comment','approval','unapproval','system')),
  body_length        int not null default 0,
  is_resolvable      boolean not null default false,
  resolved           boolean not null default false,
  created_at         timestamptz not null
);

create index if not exists mr_notes_mr_idx     on merge_request_notes(merge_request_id);
create index if not exists mr_notes_author_idx on merge_request_notes(author_engineer_id, created_at desc);

-- --- commits ------------------------------------------------------------------

create table if not exists gitlab_commits (
  id                 uuid primary key default extensions.gen_random_uuid(),
  sha                text not null,
  project_id         uuid not null references gitlab_projects(id) on delete cascade,
  merge_request_id   uuid references merge_requests(id) on delete set null,
  author_engineer_id uuid references engineers(id) on delete set null,
  author_email       text,
  author_name        text,
  title              text,
  authored_at        timestamptz not null,
  committed_at       timestamptz,
  additions          int not null default 0,
  deletions          int not null default 0,
  is_merge_commit    boolean not null default false,
  unique (project_id, sha)
);

create index if not exists commits_author_idx on gitlab_commits(author_engineer_id, authored_at desc);
create index if not exists commits_project_idx on gitlab_commits(project_id, authored_at desc);
create index if not exists commits_mr_idx on gitlab_commits(merge_request_id);

-- --- pipelines & deployments (DORA inputs) -----------------------------------

create table if not exists gitlab_pipelines (
  id            uuid primary key default extensions.gen_random_uuid(),
  gitlab_id     bigint not null unique,
  project_id    uuid not null references gitlab_projects(id) on delete cascade,
  ref           text,
  sha           text,
  status        text,            -- success | failed | canceled | running ...
  source        text,            -- push | merge_request_event | schedule ...
  is_default_branch boolean not null default false,
  created_at    timestamptz not null,
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_s    int
);

create index if not exists pipelines_project_created_idx on gitlab_pipelines(project_id, created_at desc);
create index if not exists pipelines_default_branch_idx on gitlab_pipelines(is_default_branch, created_at desc);

create table if not exists gitlab_deployments (
  id            uuid primary key default extensions.gen_random_uuid(),
  gitlab_id     bigint not null,
  project_id    uuid not null references gitlab_projects(id) on delete cascade,
  iid           bigint,
  environment   text not null,
  -- Environments are named inconsistently across repos; is_production is derived
  -- at sync time from a configurable pattern so DORA counts stay comparable.
  is_production boolean not null default false,
  status        text not null,   -- created | running | success | failed | canceled
  ref           text,
  sha           text,
  deployed_by_engineer_id uuid references engineers(id) on delete set null,
  created_at    timestamptz not null,
  finished_at   timestamptz,
  unique (project_id, gitlab_id)
);

create index if not exists deployments_prod_idx on gitlab_deployments(is_production, finished_at desc);
create index if not exists deployments_project_idx on gitlab_deployments(project_id, created_at desc);

-- Links a deployment back to the MRs it shipped, so lead-time-to-production can
-- be measured per MR rather than guessed from merge timestamps.
create table if not exists deployment_merge_requests (
  deployment_id    uuid not null references gitlab_deployments(id) on delete cascade,
  merge_request_id uuid not null references merge_requests(id) on delete cascade,
  primary key (deployment_id, merge_request_id)
);
