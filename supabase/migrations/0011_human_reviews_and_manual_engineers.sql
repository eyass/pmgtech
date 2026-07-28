-- =============================================================================
-- 0011_human_reviews_and_manual_engineers.sql
-- =============================================================================
-- Two changes driven by what real data turned up.
--
-- 1. Automated reviewers. An AI review tool comments on every merge request
--    within seconds of it opening, which made "time to first review" measure the
--    bot's latency rather than a colleague's: 675 of 1,507 merged merge requests
--    had a first_review_at set by a bot and no human reviewer at all. Bots are
--    now recorded in excluded_accounts and left out of review analysis.
--
--    Note what was NOT wrong: distinct_reviewers counts distinct engineer ids and
--    count(distinct ...) ignores nulls, so an unattributed bot never inflated
--    review coverage. Coverage is if anything understated, because a review by a
--    human whose GitLab account has not been linked to an engineer also counts
--    as nobody.
--
-- 2. Engineers who are not in HiBob — leavers whose history is still in git, and
--    contractors. They can now be created by hand and linked to an identity. The
--    HiBob sync already leaves them alone: it only deactivates rows that carry a
--    hibob_id.

-- --- excluded accounts --------------------------------------------------------

create table if not exists excluded_accounts (
  id          uuid primary key default extensions.gen_random_uuid(),
  provider    text not null check (provider in ('gitlab', 'jira')),
  -- The provider's own account id, matched against merge_request_notes.author_gitlab_id.
  external_id text not null,
  label       text,
  reason      text not null default 'bot' check (reason in ('bot', 'service-account', 'other')),
  created_at  timestamptz not null default now(),
  unique (provider, external_id)
);

comment on table excluded_accounts is
  'Accounts whose activity is excluded from review analysis — AI reviewers, CI bots, service accounts. Excluded from review timing and review counts; their comments are still stored.';

alter table excluded_accounts enable row level security;
drop policy if exists excluded_accounts_viewer_select on excluded_accounts;
create policy excluded_accounts_viewer_select on excluded_accounts
  for select to authenticated using (is_app_viewer());

-- Editable without a deploy: every org names its bots differently, and a new one
-- appearing should not need a code change to be caught.
insert into app_settings (key, value) values
  ('review_bot_patterns',
   '["bot","greptile","coderabbit","danger","renovate","dependabot","sonar","snyk","codecov"]'::jsonb)
on conflict (key) do nothing;

-- --- populate from patterns ---------------------------------------------------
-- Matches the handles and display names already collected in the triage list, so
-- existing history can be corrected without a re-sync. Safe to run repeatedly.

create or replace function sync_excluded_accounts_from_patterns()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  patterns text[];
  inserted int;
begin
  select coalesce(array_agg(lower(p)), '{}')
    into patterns
  from app_settings s,
       jsonb_array_elements_text(s.value) as p
  where s.key = 'review_bot_patterns';

  if array_length(patterns, 1) is null then
    return 0;
  end if;

  insert into excluded_accounts (provider, external_id, label, reason)
  select distinct u.provider, u.external_id,
         coalesce(u.display_name, u.external_handle),
         'bot'
  from unmatched_identities u
  where u.provider = 'gitlab'
    -- Commit-email identities are stored as "email:someone@example.com"; those are
    -- people, not accounts, and must not be swept up by a substring match.
    and u.external_id not like 'email:%'
    and exists (
      select 1 from unnest(patterns) as pat
      where lower(coalesce(u.external_handle, '')) like '%' || pat || '%'
         or lower(coalesce(u.display_name, ''))    like '%' || pat || '%'
    )
  on conflict (provider, external_id) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end $fn$;

revoke all on function sync_excluded_accounts_from_patterns() from public, anon;
grant execute on function sync_excluded_accounts_from_patterns() to service_role;

-- --- review stats, humans only -----------------------------------------------

create or replace function recompute_mr_review_stats(p_mr_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  affected int;
begin
  with stats as (
    select
      n.merge_request_id                                                  as mr_id,
      min(n.created_at) filter (where n.kind in ('comment','approval'))    as first_review_at,
      min(n.created_at) filter (where n.kind = 'approval')                 as first_approval_at,
      count(distinct n.author_engineer_id)
        filter (where n.kind in ('comment','approval'))                    as distinct_reviewers,
      count(*) filter (where n.kind = 'comment')::int                      as notes_count,
      count(*) filter (where n.kind = 'approval')::int                     as approvals_count
    from merge_request_notes n
    join merge_requests mr on mr.id = n.merge_request_id
    where (p_mr_ids is null or n.merge_request_id = any(p_mr_ids))
      -- Self-comments are not reviews.
      and (n.author_engineer_id is null or n.author_engineer_id is distinct from mr.author_engineer_id)
      -- Neither is an AI reviewer or a CI bot. Without this, first_review_at is the
      -- bot's response time and "time to first review" reads as a couple of minutes
      -- on every merge request.
      and not exists (
        select 1 from excluded_accounts x
        where x.provider = 'gitlab' and x.external_id = n.author_gitlab_id
      )
    group by n.merge_request_id
  )
  update merge_requests mr
     set first_review_at    = stats.first_review_at,
         first_approval_at  = stats.first_approval_at,
         distinct_reviewers = stats.distinct_reviewers,
         notes_count        = stats.notes_count,
         approvals_count    = greatest(mr.approvals_count, stats.approvals_count)
    from stats
   where mr.id = stats.mr_id;

  get diagnostics affected = row_count;

  -- A merge request whose only comments came from bots has no review at all. It
  -- would otherwise keep the values from before this ran.
  update merge_requests mr
     set first_review_at = null,
         first_approval_at = null,
         distinct_reviewers = 0
   where (p_mr_ids is null or mr.id = any(p_mr_ids))
     and not exists (
       select 1
       from merge_request_notes n
       where n.merge_request_id = mr.id
         and n.kind in ('comment','approval')
         and (n.author_engineer_id is null or n.author_engineer_id is distinct from mr.author_engineer_id)
         and not exists (
           select 1 from excluded_accounts x
           where x.provider = 'gitlab' and x.external_id = n.author_gitlab_id
         )
     )
     and (mr.first_review_at is not null or mr.distinct_reviewers <> 0);

  return affected;
end $fn$;

revoke all on function recompute_mr_review_stats(uuid[]) from public, anon;
grant execute on function recompute_mr_review_stats(uuid[]) to service_role;

-- --- review events, humans only ----------------------------------------------

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
  -- Time the reviewer took to respond after the MR was opened.
  extract(epoch from (n.created_at - mr.opened_at)) / 3600.0 as response_hours
from merge_request_notes n
join merge_requests mr on mr.id = n.merge_request_id
join gitlab_projects p on p.id = mr.project_id
left join engineers re on re.id = n.author_engineer_id
left join engineers ae on ae.id = mr.author_engineer_id
where n.kind in ('comment', 'approval')
  -- A note by the MR author on their own MR is not a review.
  and (n.author_engineer_id is null or n.author_engineer_id <> mr.author_engineer_id)
  -- Automated reviewers are not collaboration.
  and not exists (
    select 1 from excluded_accounts x
    where x.provider = 'gitlab' and x.external_id = n.author_gitlab_id
  );
