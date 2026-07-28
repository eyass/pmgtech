-- =============================================================================
-- 0012_release_grained_dora.sql — count releases, not environment-deployments
-- =============================================================================
-- DORA metrics were counting rows in gitlab_deployments, which is one row per
-- environment. This monorepo ships to six brands across about ten services, so a
-- single release fans out into dozens of production deployment records — measured
-- on real data, 23,514 rows for 345 distinct commits, about 68 to one.
--
-- The consequences were not subtle:
--  * deploy frequency read around 17,000/week, which is fan-out times releases
--    rather than anything DORA means;
--  * change failure rate counted one bad release up to 68 times, making it a
--    measure of infrastructure flakiness rather than change quality;
--  * MTTR matched a failure to the next success in the *same environment*, which an
--    automatic retry satisfied in minutes — hence the implausible 0.1 hours.
--
-- v_prod_deployments keeps its environment grain. It is honest about what it is and
-- still the right thing for looking at one environment. These views sit alongside it,
-- and the aggregation functions are repointed at them.

-- --- releases -----------------------------------------------------------------

create or replace view v_prod_releases with (security_invoker = true) as
select
  d.project_id,
  d.sha,
  min(d.project_name)                                     as project_name,
  -- Squad by weight of evidence across the release's deployments.
  mode() within group (order by d.squad_id)                as squad_id,
  count(*)::int                                            as environment_deploys,
  count(*) filter (where d.succeeded)::int                 as environments_succeeded,
  count(*) filter (where not d.succeeded)::int             as environments_failed,
  bool_or(d.succeeded)                                     as had_success,
  bool_or(not d.succeeded)                                 as had_failure,
  min(d.finished_at)                                       as first_finished_at,
  max(d.finished_at)                                       as last_finished_at,
  min(d.finished_at) filter (where not d.succeeded)        as first_failed_at,
  -- Clean only if every environment took it.
  (bool_or(d.succeeded) and not bool_or(not d.succeeded))  as succeeded,
  -- Aliased so a consumer written against the deployment-grained view can be moved
  -- to releases by changing only the view name. That is what keeps the repointing
  -- below a substitution rather than a rewrite of four large functions.
  min(d.finished_at)                                       as finished_at
from v_prod_deployments d
group by d.project_id, d.sha;

comment on view v_prod_releases is
  'One row per commit reaching production. succeeded means every production environment took it; had_failure means at least one did not. Use this for DORA rather than v_prod_deployments, which is one row per environment and inflates counts by the deployment fan-out.';

create or replace view v_release_recovery with (security_invoker = true) as
select
  f.project_id,
  f.squad_id,
  f.sha,
  coalesce(f.first_failed_at, f.last_finished_at)                     as failed_at,
  r.recovered_at,
  extract(epoch from (r.recovered_at - coalesce(f.first_failed_at, f.last_finished_at))) / 3600.0
                                                                      as recovery_hours
from v_prod_releases f
cross join lateral (
  -- The next release that went out cleanly, anywhere in the project. Matching per
  -- environment is what made the old figure meaningless.
  select min(s.first_finished_at) as recovered_at
  from v_prod_releases s
  where s.project_id = f.project_id
    and s.succeeded
    and s.first_finished_at > coalesce(f.first_failed_at, f.last_finished_at)
) r
where f.had_failure
  and r.recovered_at is not null;

-- --- repoint the aggregation functions ----------------------------------------
-- Substitution against the stored definitions rather than four restatements, so
-- the remainder of each function body is provably untouched. Idempotent: a second
-- run finds no references left and does nothing.

do $mig$
declare
  target text;
  def text;
  newdef text;
begin
  foreach target in array array['squad_scorecards','team_health','delivery_trend','org_kpis'] loop
    select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = target
    limit 1;

    if def is null then
      raise notice 'skipped %, not found', target;
      continue;
    end if;

    newdef := replace(def, 'v_deployment_recovery', 'v_release_recovery');
    newdef := replace(newdef, 'v_prod_deployments', 'v_prod_releases');

    if newdef = def then
      raise notice '% referenced neither view, left alone', target;
      continue;
    end if;

    execute newdef;
    raise notice 'repointed %', target;
  end loop;
end $mig$;
