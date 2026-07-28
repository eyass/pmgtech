-- =============================================================================
-- 0008_tighten_rpc_grants.sql — remove the default PUBLIC execute grant
-- =============================================================================
-- Postgres grants EXECUTE on new functions to PUBLIC, which in Supabase means the
-- anon role can call them over /rest/v1/rpc. The metrics functions are SECURITY
-- INVOKER, so RLS already returns nothing to an unauthenticated caller — but the
-- endpoints should not be reachable at all. Revoke PUBLIC/anon and re-grant only
-- to the roles that need them.

do $grants$
declare
  fn text;
  signatures text[] := array[
    'squad_scorecards(timestamptz, timestamptz)',
    'org_kpis(timestamptz, timestamptz)',
    'delivery_trend(timestamptz, timestamptz, text, uuid)',
    'engineer_scorecards(timestamptz, timestamptz, uuid)',
    'seniority_benchmark(timestamptz, timestamptz, uuid)',
    'review_network(timestamptz, timestamptz)',
    'sprint_scorecards(uuid, int)',
    'work_type_mix(timestamptz, timestamptz)',
    'mr_attention_list(uuid, int)',
    'normalise_seniority(text)',
    'set_updated_at()'
  ];
begin
  foreach fn in array signatures loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end $grants$;

-- The write-side helpers are service-role only; they were already revoked from
-- public and anon when created, but assert it here so the intent is in one place.
revoke all on function upsert_unmatched_identities(jsonb)      from public, anon, authenticated;
revoke all on function reattribute_from_identities()           from public, anon, authenticated;
revoke all on function recompute_mr_review_stats(uuid[])       from public, anon, authenticated;
revoke all on function recompute_issue_cycle_starts(uuid[])    from public, anon, authenticated;
revoke all on function link_mrs_to_issues()                    from public, anon, authenticated;

grant execute on function upsert_unmatched_identities(jsonb)   to service_role;
grant execute on function reattribute_from_identities()        to service_role;
grant execute on function recompute_mr_review_stats(uuid[])    to service_role;
grant execute on function recompute_issue_cycle_starts(uuid[]) to service_role;
grant execute on function link_mrs_to_issues()                 to service_role;
