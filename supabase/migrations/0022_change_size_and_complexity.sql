-- =============================================================================
-- 0022_change_size_and_complexity.sql — measure how much a merge request contains
-- =============================================================================
--
-- Throughput counted merge requests, so a three-line change and a nine-hundred-line
-- refactor were worth exactly the same. That is gameable in the obvious direction:
-- split the work, ship more units, score higher. This file adds a size-aware weight
-- so a merge request is worth roughly "how many median-sized merge requests is this",
-- and feeds it into the throughput dimension of engineer scoring.
--
-- First, the reason this could not have worked before. Every row in merge_requests
-- and gitlab_commits carried additions = 0, deletions = 0, changed_files = 0 — all
-- 2,000 merge requests and all 9,893 commits. The sync read `mr.diff_stats`, which
-- the GitLab REST merge-request endpoint does not return, and fetched merge-request
-- commits without `with_stats`, so `commit.stats` was always undefined. Both writes
-- landed on their `?? 0` fallback. Three metrics were silently dead as a result:
-- large_mr_pct (churn > 400) read 0% for everybody, median_mr_churn read 0, and
-- squad code_churn read 0.
--
-- So the first thing here is not the metric, it is making a missing measurement
-- look missing:
--
--   size_source records where a size came from, and null means nobody has ever
--   measured this row. The views below expose churn as NULL in that case, so every
--   downstream metric withholds itself the way it already does for a thin sample,
--   instead of confidently reporting zero. A metric that cannot tell "no data" from
--   "no change" will eventually be believed.
--
-- The weight itself, per merge request:
--
--   points = log2(1 + churn / median_churn) × breadth,  capped at 6, floored at 0.1
--
-- Three properties, each load-bearing:
--
--   * Self-calibrating. The unit is the org's own median merged merge request over
--     the period, so a median one scores 1.0 and nothing depends on a line count I
--     invented. A team whose normal change is 40 lines and one whose normal change
--     is 400 both get a scale that fits them.
--   * Sublinear. 63× the lines is 6× the weight, and the cap stops one vendored
--     dependency dump or generated-file commit from outscoring a quarter of real
--     work. Rewarding churn linearly would just move the gaming from many-small to
--     one-enormous, which is worse: large changes are harder to review.
--   * A floor with teeth. A change of ten lines or fewer touching one file scores
--     0.1 — a twentieth of the old value of 1.0. Twenty of those are worth two
--     median merge requests, which is the whole point.
--
-- Breadth is a mild multiplier (up to 1.5× at many files), because coordinating a
-- change across thirty files is work that a line count alone misses.
--
-- What this deliberately does not do:
--
--   * It does not measure cognitive complexity. Nothing here parses source, so
--     nesting, coupling and cleverness are invisible. This is size, breadth and
--     the effort they imply — an antidote to unit-counting, not a code-quality
--     judgement.
--   * It does not rescue the hard one-liner. A change that took three days to find
--     and one line to fix scores 0.1, and no telemetry available here can tell it
--     apart from a typo fix. That case is exactly what the raw count beside the
--     weighted one, and a human, are for.
--   * It does not use time spent. Weighting by cycle time would score slowness as
--     complexity and reward sitting on a branch.
--
-- Paired against gaming in the other direction, per the framework's counter-metric
-- rule: throughput now rewards size, and quality already penalises it —
-- large_mr_pct, review coverage received and review iterations all degrade as
-- merge requests get bigger. Pushing one moves the other.

-- --- where a size came from ---------------------------------------------------

alter table merge_requests
  add column if not exists size_source text
    check (size_source in ('diff_stats', 'changes_count', 'commits_sum', 'unavailable')),
  add column if not exists size_measured_at timestamptz;

comment on column merge_requests.size_source is
  'How additions/deletions/changed_files were obtained. NULL means never measured — the views expose churn as NULL so metrics withhold rather than reporting zero. ''unavailable'' means the API was asked and had nothing.';

alter table gitlab_commits
  add column if not exists size_source text
    check (size_source in ('list_stats', 'commit_api', 'unavailable')),
  add column if not exists size_measured_at timestamptz;

comment on column gitlab_commits.size_source is
  'How additions/deletions were obtained. NULL means never measured. ''list_stats'' came free with the commit listing, ''commit_api'' cost a call.';

-- Backfill queue lookups: find the rows still needing a measurement, newest first.
create index if not exists merge_requests_unsized_idx
  on merge_requests(merged_at desc nulls last) where size_source is null;
create index if not exists gitlab_commits_unsized_idx
  on gitlab_commits(authored_at desc) where size_source is null;

-- Rows written before this migration have never been measured, and their zeros are
-- not measurements. Marked NULL rather than left at 0 so they queue for backfill.
update merge_requests set size_source = null
 where size_source is null and additions = 0 and deletions = 0 and changed_files = 0;

-- --- the weight ---------------------------------------------------------------

create or replace function mr_complexity_points(
  p_churn        numeric,
  p_files        numeric,
  p_median_churn numeric
)
returns numeric
language sql
immutable
set search_path = public, extensions
as $$
  select case
    -- Never measured. Not zero — unknown, and it has to stay distinguishable.
    when p_churn is null then null
    -- The anti-gaming floor: ten lines or fewer in a single file is a twentieth of
    -- a median merge request, whatever else is true about it.
    when p_churn <= 10 and coalesce(p_files, 1) <= 1 then 0.1
    when p_median_churn is null or p_median_churn <= 0 then null
    else round(
      least(
        6.0,
        greatest(
          0.1,
          log(2.0, 1.0 + p_churn / p_median_churn)
            -- Breadth, capped: a change spread over many files costs coordination
            -- that its line count does not show.
            * least(1.5, 1.0 + 0.10 * log(2.0, 1.0 + coalesce(p_files, 0)))
        )
      ),
      2
    )
  end
$$;

comment on function mr_complexity_points(numeric, numeric, numeric) is
  'Size-aware weight for one merge request, in units of "median merged merge request". Sublinear in churn, capped at 6, floored at 0.1 for trivial single-file changes. NULL when the size was never measured.';

-- --- merge requests, with a size that admits when it is unknown ---------------

create or replace view v_mr_size with (security_invoker = true) as
select
  mr.id                                   as merge_request_id,
  mr.author_engineer_id,
  mr.merged_at,
  mr.state,
  mr.is_draft,
  mr.size_source,
  -- The whole point of the column: unmeasured reads NULL, not 0. 'changes_count' is
  -- the partial case — GitLab gave a file count but no line counts — so churn stays
  -- unknown there while changed_files is real.
  case when mr.size_source in ('diff_stats', 'commits_sum')
       then mr.additions + mr.deletions end            as churn,
  case when mr.size_source is null or mr.size_source = 'unavailable' then null
       else mr.changed_files end                       as changed_files,
  mr.commits_count
from merge_requests mr
where not exists (
        select 1 from v_ignored_engineers ig where ig.id = mr.author_engineer_id);

comment on view v_mr_size is
  'Per-merge-request size with unmeasured rows as NULL rather than zero. The basis of every complexity figure.';

-- --- per-engineer complexity over a period ------------------------------------
-- Returned separately from engineer_profiles rather than folded into it, because
-- the median it calibrates against is a property of the period, and because a
-- caller should be able to ask "how well measured is this?" without also pulling
-- twenty other signals.

create or replace function engineer_complexity(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  engineer_id        uuid,
  merged_mrs         int,
  sized_mrs          int,
  sized_mr_pct       numeric,
  median_churn       numeric,
  org_median_churn   numeric,
  effective_mrs      numeric,
  points_per_mr      numeric,
  trivial_mrs        int,
  trivial_mr_pct     numeric,
  large_mrs          int,
  max_points         numeric
)
language sql
stable
set search_path = public, extensions
as $fn$
with merged as (
  select * from v_mr_size
  where merged_at >= p_from and merged_at < p_to and author_engineer_id is not null
),
-- One median for the whole org over the period, so every engineer is weighed on the
-- same scale. A per-engineer median would make everyone's own normal size score 1.0
-- and measure nothing at all.
org as (
  select percentile_cont(0.5) within group (order by churn)::numeric as median_churn
  from merged
  where churn is not null
),
scored as (
  select
    m.*,
    mr_complexity_points(m.churn, m.changed_files, org.median_churn) as points,
    org.median_churn                                                 as org_median
  from merged m
  cross join org
)
select
  s.author_engineer_id,
  count(*)::int                                                            as merged_mrs,
  count(*) filter (where s.churn is not null)::int                         as sized_mrs,
  round(100.0 * count(*) filter (where s.churn is not null) / nullif(count(*), 0)::numeric, 1),
  round(percentile_cont(0.5) within group (order by s.churn)::numeric, 0)  as median_churn,
  round(max(s.org_median)::numeric, 0)                                     as org_median_churn,
  round(sum(s.points), 2)                                                  as effective_mrs,
  -- Below 1.0 means their merge requests are smaller than the org's median one.
  round(sum(s.points) / nullif(count(*) filter (where s.points is not null), 0), 2) as points_per_mr,
  count(*) filter (where s.points = 0.1)::int                              as trivial_mrs,
  round(100.0 * count(*) filter (where s.points = 0.1)
        / nullif(count(*) filter (where s.points is not null), 0)::numeric, 1),
  count(*) filter (where s.churn > 400)::int                               as large_mrs,
  max(s.points)                                                            as max_points
from scored s
group by s.author_engineer_id;
$fn$;

comment on function engineer_complexity(timestamptz, timestamptz) is
  'Per-engineer complexity-weighted throughput. effective_mrs is the sum of per-MR weights in units of median merged MR; sized_mr_pct says how much of it rests on a real measurement.';

-- --- per-squad, same basis ----------------------------------------------------

create or replace function squad_complexity(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  squad_id       uuid,
  merged_mrs     int,
  sized_mr_pct   numeric,
  median_churn   numeric,
  effective_mrs  numeric,
  points_per_mr  numeric,
  trivial_mr_pct numeric
)
language sql
stable
set search_path = public, extensions
as $fn$
with merged as (
  select m.squad_id, s.churn, s.changed_files
  from v_merge_requests m
  join v_mr_size s on s.merge_request_id = m.id
  where m.merged_at >= p_from and m.merged_at < p_to and m.squad_id is not null
),
org as (
  select percentile_cont(0.5) within group (order by churn)::numeric as median_churn
  from merged where churn is not null
),
scored as (
  select m.*, mr_complexity_points(m.churn, m.changed_files, org.median_churn) as points
  from merged m cross join org
)
select
  s.squad_id,
  count(*)::int,
  round(100.0 * count(*) filter (where s.churn is not null) / nullif(count(*), 0)::numeric, 1),
  round(percentile_cont(0.5) within group (order by s.churn)::numeric, 0),
  round(sum(s.points), 2),
  round(sum(s.points) / nullif(count(*) filter (where s.points is not null), 0), 2),
  round(100.0 * count(*) filter (where s.points = 0.1)
        / nullif(count(*) filter (where s.points is not null), 0)::numeric, 1)
from scored s
group by s.squad_id;
$fn$;

comment on function squad_complexity(timestamptz, timestamptz) is
  'Per-squad complexity-weighted throughput on the same org-wide median scale as engineer_complexity.';

-- --- grants -------------------------------------------------------------------

revoke all on function mr_complexity_points(numeric, numeric, numeric) from public, anon;
revoke all on function engineer_complexity(timestamptz, timestamptz)   from public, anon;
revoke all on function squad_complexity(timestamptz, timestamptz)      from public, anon;

grant execute on function mr_complexity_points(numeric, numeric, numeric) to authenticated, service_role;
grant execute on function engineer_complexity(timestamptz, timestamptz)   to authenticated, service_role;
grant execute on function squad_complexity(timestamptz, timestamptz)      to authenticated, service_role;

-- --- deriving a merge request's size from its commits --------------------------
-- The size backfill measures commits, and a merge request becomes measurable the
-- moment its last unmeasured commit is — which is not necessarily a row the caller
-- just touched. So this is a set operation rather than something the loop can do.
--
-- Only merge requests whose commits are *all* measured are resized. A partial sum
-- understates the change, and an understatement is worse than a gap here: the gap
-- shows up in sized_mr_pct, the understatement shows up nowhere and quietly makes
-- someone look like they ship small.

create or replace function resize_mrs_from_commits()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  updated int;
begin
  with candidate as (
    select
      c.merge_request_id                            as mr_id,
      sum(c.additions)                              as additions,
      sum(c.deletions)                              as deletions,
      count(*)                                      as commits,
      count(*) filter (where c.size_source is null) as unmeasured,
      count(*) filter (where c.size_source = 'unavailable') as unavailable
    from gitlab_commits c
    join merge_requests mr on mr.id = c.merge_request_id
    where c.merge_request_id is not null
      -- Only rows still without a line count of their own. A merge request the API
      -- gave real diff stats for is never overwritten by a commit sum.
      and (mr.size_source is null or mr.size_source in ('changes_count', 'unavailable'))
      and not c.is_merge_commit
    group by c.merge_request_id
  )
  update merge_requests mr
     set additions        = candidate.additions,
         deletions        = candidate.deletions,
         size_source      = 'commits_sum',
         size_measured_at = now()
    from candidate
   where mr.id = candidate.mr_id
     and candidate.unmeasured = 0
     and candidate.unavailable = 0
     and candidate.commits > 0;

  get diagnostics updated = row_count;
  return updated;
end $fn$;

comment on function resize_mrs_from_commits() is
  'Sets merge-request line counts from the sum of their commits, for MRs whose commits are all measured and which have no line count of their own. Returns rows updated.';

-- Service-role only: it is a write, and the sync is the only caller.
revoke all on function resize_mrs_from_commits() from public, anon, authenticated;
grant execute on function resize_mrs_from_commits() to service_role;
