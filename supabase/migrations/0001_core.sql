-- =============================================================================
-- 0001_core.sql — squads, engineers, identity resolution, sync bookkeeping
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- --- squads -------------------------------------------------------------------

create table if not exists squads (
  id          uuid primary key default extensions.gen_random_uuid(),
  key         text not null unique,          -- 'buyer' | 'seller' | 'monetization' | 'growth'
  name        text not null,
  description text,
  colour      text not null default '#64748b',
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into squads (key, name, description, colour, sort_order) values
  ('buyer',        'Team Buyer',        'Buyer-side discovery, search and enquiry experience', '#2563eb', 1),
  ('seller',       'Team Seller',       'Seller onboarding, listing management and tooling',   '#059669', 2),
  ('monetization', 'Team Monetization', 'Pricing, payments, PetPay and value-added services',  '#d97706', 3),
  ('growth',       'Team Growth',       'Acquisition, retention, lifecycle and experimentation', '#7c3aed', 4)
on conflict (key) do nothing;

-- --- seniority ladder ---------------------------------------------------------
-- HiBob job titles / levels are free text; we normalise them onto this ladder so
-- that "is this person delivering in line with their level" comparisons work.

create table if not exists seniority_levels (
  id    serial primary key,
  key   text not null unique,
  label text not null,
  rank  int  not null unique          -- higher rank == more senior
);

insert into seniority_levels (key, label, rank) values
  ('intern',    'Intern / Apprentice', 10),
  ('junior',    'Junior Engineer',     20),
  ('mid',       'Engineer',            30),
  ('senior',    'Senior Engineer',     40),
  ('staff',     'Staff Engineer',      50),
  ('principal', 'Principal Engineer',  60),
  ('lead',      'Tech Lead',           55),
  ('manager',   'Engineering Manager', 65),
  ('director',  'Director / Head of',  70),
  ('unknown',   'Unknown',              0)
on conflict (key) do nothing;

-- Patterns used to map a raw HiBob title onto the ladder. Ordered by priority so
-- that "senior staff engineer" resolves to staff, not senior.
create table if not exists seniority_title_patterns (
  id           serial primary key,
  pattern      text not null unique, -- case-insensitive regex matched against the raw title
  seniority_key text not null references seniority_levels(key),
  priority     int  not null default 100
);

insert into seniority_title_patterns (pattern, seniority_key, priority) values
  ('(director|head of|vp |vice president|cto)', 'director',  10),
  -- \y is the Postgres ARE word boundary (\b means backspace here)
  ('(engineering manager|eng manager|\yem\y)',  'manager',   20),
  ('(principal)',                               'principal', 30),
  ('(staff)',                                   'staff',     40),
  ('(tech lead|team lead|lead engineer)',       'lead',      50),
  ('(senior|snr|sr\.?\s)',                      'senior',    60),
  ('(junior|jnr|jr\.?\s|graduate|grad )',       'junior',    70),
  ('(intern|apprentice|placement|trainee)',     'intern',    80),
  ('(engineer|developer|programmer|sre|devops)','mid',      900)
on conflict (pattern) do nothing;

-- --- engineers ----------------------------------------------------------------

create table if not exists engineers (
  id                uuid primary key default extensions.gen_random_uuid(),
  email             text unique,
  full_name         text not null,
  display_name      text,
  avatar_url        text,

  squad_id          uuid references squads(id) on delete set null,
  -- squad_source records whether the squad came from HiBob's department field or
  -- was set by hand in the admin screen. Manual always wins over a sync.
  squad_source      text not null default 'unassigned'
                      check (squad_source in ('unassigned','hibob','manual')),

  -- HiBob-sourced HR attributes
  hibob_id          text unique,
  job_title         text,
  seniority_key     text references seniority_levels(key) default 'unknown',
  seniority_source  text not null default 'unknown'
                      check (seniority_source in ('unknown','hibob','manual')),
  department        text,
  site              text,
  manager_email     text,
  start_date        date,
  employment_type   text,
  is_active         boolean not null default true,

  -- true for people we want to appear in delivery metrics (excludes contractors
  -- you do not track, PMs sitting in the same HiBob department, etc.)
  include_in_metrics boolean not null default true,

  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists engineers_squad_idx on engineers(squad_id);
create index if not exists engineers_active_idx on engineers(is_active) where is_active;
create index if not exists engineers_email_lower_idx on engineers(lower(email));

-- --- identities ---------------------------------------------------------------
-- One engineer has many external identities: a GitLab user id, a GitLab
-- username, a Jira accountId, extra work/personal commit emails. Sync writes
-- rows here; anything unmatched lands in unmatched_identities for triage.

create table if not exists engineer_identities (
  id            uuid primary key default extensions.gen_random_uuid(),
  engineer_id   uuid not null references engineers(id) on delete cascade,
  provider      text not null check (provider in ('gitlab','jira','hibob','email')),
  external_id   text not null,           -- numeric id / accountId / email
  external_handle text,                  -- username, display name
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (provider, external_id)
);

create index if not exists engineer_identities_engineer_idx on engineer_identities(engineer_id);

-- Identities seen in GitLab/Jira that we could not tie to an engineer. Surfaced
-- in the admin screen so the mapping can be completed by hand.
create table if not exists unmatched_identities (
  id            uuid primary key default extensions.gen_random_uuid(),
  provider      text not null check (provider in ('gitlab','jira')),
  external_id   text not null,
  external_handle text,
  display_name  text,
  email         text,
  event_count   int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  dismissed     boolean not null default false,
  unique (provider, external_id)
);

-- --- sync bookkeeping ---------------------------------------------------------

create table if not exists sync_runs (
  id            uuid primary key default extensions.gen_random_uuid(),
  source        text not null check (source in ('gitlab','jira','hibob','all')),
  mode          text not null default 'incremental' check (mode in ('incremental','backfill')),
  status        text not null default 'running' check (status in ('running','success','partial','error')),
  trigger       text not null default 'manual' check (trigger in ('manual','cron','api')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  duration_ms   int,
  stats         jsonb not null default '{}'::jsonb,
  error         text,
  log           jsonb not null default '[]'::jsonb
);

create index if not exists sync_runs_source_started_idx on sync_runs(source, started_at desc);

-- Per-source incremental cursors, e.g. gitlab:merge_requests:<project> -> ISO ts
create table if not exists sync_cursors (
  source     text not null,
  key        text not null,
  value      text,
  updated_at timestamptz not null default now(),
  primary key (source, key)
);

-- --- helpers ------------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists squads_updated_at on squads;
create trigger squads_updated_at before update on squads
  for each row execute function set_updated_at();

drop trigger if exists engineers_updated_at on engineers;
create trigger engineers_updated_at before update on engineers
  for each row execute function set_updated_at();

-- Normalise a raw HiBob job title onto the seniority ladder.
create or replace function normalise_seniority(p_title text)
returns text
language sql stable as $$
  select coalesce(
    (select p.seniority_key
       from seniority_title_patterns p
      where p_title is not null and p_title ~* p.pattern
      order by p.priority
      limit 1),
    'unknown'
  );
$$;
