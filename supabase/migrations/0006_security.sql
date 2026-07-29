-- =============================================================================
-- 0006_security.sql — app settings, RLS, and read policies
-- =============================================================================
-- The dashboard reads through the service-role key from server components, which
-- bypasses RLS. Policies are still defined so that (a) the anon key can never
-- read anything, and (b) direct client-side queries remain possible later
-- without reopening the data.

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value) values
  ('allowed_email_domains', '["petmediagroup.com"]'::jsonb),
  ('production_environment_patterns', '["production","prod","live"]'::jsonb),
  ('backfill_months', '12'::jsonb)
on conflict (key) do nothing;

create table if not exists app_admins (
  email      text primary key,
  note       text,
  created_at timestamptz not null default now()
);

-- --- viewer predicate ---------------------------------------------------------
-- security definer so it can read app_settings while app_settings itself stays
-- locked down.

create or replace function is_app_viewer()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from app_settings s,
         jsonb_array_elements_text(s.value) as d(domain)
    where s.key = 'allowed_email_domains'
      and lower(coalesce(auth.jwt() ->> 'email', '')) like '%@' || lower(d.domain)
  );
$$;

revoke all on function is_app_viewer() from public;
revoke execute on function is_app_viewer() from anon;
grant execute on function is_app_viewer() to authenticated, service_role;

-- --- enable RLS + read policy on every data table -----------------------------

do $$
declare
  t text;
  data_tables text[] := array[
    'squads','engineers','engineer_identities','unmatched_identities',
    'seniority_levels','seniority_title_patterns',
    'gitlab_projects','merge_requests','merge_request_notes','gitlab_commits',
    'gitlab_pipelines','gitlab_deployments','deployment_merge_requests',
    'jira_projects','jira_boards','jira_sprints','jira_issues',
    'jira_issue_sprints','jira_status_transitions','issue_merge_requests',
    'sync_runs','sync_cursors','app_settings','app_admins'
  ];
begin
  foreach t in array data_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_viewer_select', t);
    -- app_settings and app_admins hold configuration, not metrics: no client
    -- read access at all, only the service role.
    if t not in ('app_settings','app_admins') then
      execute format(
        'create policy %I on %I for select to authenticated using (is_app_viewer())',
        t || '_viewer_select', t
      );
    end if;
  end loop;
end $$;

-- --- function grants ----------------------------------------------------------

grant execute on function squad_scorecards(timestamptz, timestamptz)          to authenticated, service_role;
grant execute on function org_kpis(timestamptz, timestamptz)                  to authenticated, service_role;
grant execute on function delivery_trend(timestamptz, timestamptz, text, uuid) to authenticated, service_role;
grant execute on function engineer_scorecards(timestamptz, timestamptz, uuid) to authenticated, service_role;
grant execute on function seniority_benchmark(timestamptz, timestamptz, uuid) to authenticated, service_role;
grant execute on function review_network(timestamptz, timestamptz)            to authenticated, service_role;
grant execute on function sprint_scorecards(uuid, int)                        to authenticated, service_role;
grant execute on function work_type_mix(timestamptz, timestamptz)             to authenticated, service_role;
grant execute on function mr_attention_list(uuid, int)                        to authenticated, service_role;
grant execute on function normalise_seniority(text)                           to authenticated, service_role;
