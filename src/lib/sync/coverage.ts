import { appEnv } from '@/lib/env'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { readWindowCoverage, type StreamFrontier, type WindowCoverage } from '@/lib/trust'

/**
 * How far back the collection actually reaches, per stream.
 *
 * This is the read behind the depth section of `/trust`, and it exists because the
 * app had no way to tell a quiet quarter from an uncollected one. On 2026-07-31
 * production held 1,472 of 1,718 merged merge requests inside the last 90 days
 * against an earliest merge of 2021-04-09, and every reading of that shape is
 * flattering: it looks like a team that got faster. What it actually was is a
 * backward walk that had reached 2026-04-29 and stopped, so the 6m and 12m period
 * selectors were serving three months of history under a twelve-month label.
 *
 * The authority for depth is the walk's own frontier cursor, not the rows. A row
 * count cannot distinguish "nothing shipped that month" from "that month was never
 * requested", and those two produce the same chart. `sync_cursors` holds the answer
 * directly: every backward pass writes `…:oldest` as it goes, and everything between
 * the configured window start and that value has never been asked for.
 *
 * Which streams, and why each is separate:
 *
 *  - **Merge requests** — the denominator of throughput, lead time, review wait and
 *    review coverage. Frontier `project:<id>:merge_requests:oldest`.
 *  - **Production deployments** — every DORA figure. Its own frontier, and always
 *    the shallowest of the three: this org emits ~2,000 deployments per seven hours,
 *    so the listing hits its page limit long before merge requests do. Reading its
 *    depth off the merge-request walk would overstate it by weeks.
 *  - **Pipelines** — change failure rate's raw material, with the same problem.
 *  - **Jira issues** — no frontier at all, by design. That walk goes *forward* from
 *    the window start, so the only evidence it covered the window is the run that
 *    reported `backfill_complete`, and that is what is read here.
 */

/** A window to measure coverage against. Structural, so this file need not import queries. */
export interface CoverageRange {
  from: Date
  to: Date
}

type GitLabStream = {
  label: string
  /** The `:oldest` cursor suffix this stream writes. */
  cursorSuffix: string
  table: string
  /** Column the metrics filter the window on, which is what coverage must be about. */
  dateColumn: string
  consequence: string
}

const GITLAB_STREAMS: GitLabStream[] = [
  {
    label: 'Merge requests',
    cursorSuffix: ':merge_requests:oldest',
    table: 'merge_requests',
    dateColumn: 'merged_at',
    consequence:
      'Throughput, lead time, review wait and review coverage are all counted over a shorter span than the period claims.',
  },
  {
    label: 'Production deployments',
    cursorSuffix: ':deployments:oldest',
    table: 'gitlab_deployments',
    dateColumn: 'created_at',
    consequence:
      'Deploy frequency, change failure rate and time to restore describe only the collected tail of the period.',
  },
  {
    label: 'Pipelines',
    cursorSuffix: ':pipelines:oldest',
    table: 'gitlab_pipelines',
    dateColumn: 'created_at',
    consequence: 'Pipeline success and change failure rate rest on a shorter span than the period.',
  },
]

/**
 * Read every stream's depth and turn it into coverage of `range`.
 *
 * Never throws. The trust page's job is to state what is known, and a page that
 * 500s because it could not measure its own confidence is worse than one that says
 * the measurement is unavailable — so a failed read becomes an unknown frontier,
 * which `readWindowCoverage` renders as unknown rather than as covered.
 */
export async function getWindowCoverage(range: CoverageRange): Promise<WindowCoverage[]> {
  const db = supabaseAdmin()
  const backfillMonths = appEnv().backfillMonths

  const [cursors, tracked, latestRuns] = await Promise.all([
    db.from('sync_cursors').select('source, key, value').eq('source', 'gitlab'),
    db.from('gitlab_projects').select('gitlab_id').eq('is_tracked', true).eq('archived', false),
    db
      .from('sync_runs')
      .select('source, status, started_at, stats')
      .order('started_at', { ascending: false })
      .limit(120),
  ])

  const cursorRows = (cursors.data ?? []) as { key: string; value: string | null }[]
  const trackedIds = ((tracked.data ?? []) as { gitlab_id: number }[]).map((p) => p.gitlab_id)
  const runRows = (latestRuns.data ?? []) as {
    source: string
    status: string
    stats: Record<string, unknown> | null
  }[]

  const configuredWindowStart = windowStart(backfillMonths)
  const frontiers: StreamFrontier[] = []

  for (const stream of GITLAB_STREAMS) {
    frontiers.push({
      label: stream.label,
      source: 'gitlab',
      reachedBackTo: gitlabFrontier(cursorRows, trackedIds, stream.cursorSuffix),
      complete: reportedBackfillComplete(runRows, 'gitlab'),
      configuredWindowStart,
      earliestRecordAt: await earliestRecord(db, stream.table, stream.dateColumn),
      rowsInWindow: await rowsInWindow(db, stream.table, stream.dateColumn, range),
      consequence: stream.consequence,
    })
  }

  frontiers.push({
    label: 'Resolved issues',
    source: 'jira',
    // No frontier exists to read: the issue walk is forward-only, ordered `updated
    // ASC` from the window start, so there is no `:oldest` cursor and never was. Depth
    // here rests entirely on a run having reported that it reached the present with
    // nothing left behind — which is what `backfill_complete` means — and that claim is
    // carried by `complete` rather than restated as a frontier this walk never wrote.
    reachedBackTo: null,
    complete: reportedBackfillComplete(runRows, 'jira'),
    configuredWindowStart,
    earliestRecordAt: await earliestRecord(db, 'jira_issues', 'resolved_at'),
    rowsInWindow: await rowsInWindow(db, 'jira_issues', 'resolved_at', range),
    consequence:
      'Issues resolved, bug ratio and issue cycle time cover only the collected part of the period.',
  })

  return readWindowCoverage(frontiers, range)
}

/** Start of the collection window the sync is configured for: `BACKFILL_MONTHS` ago. */
function windowStart(backfillMonths: number): string {
  const from = new Date()
  from.setMonth(from.getMonth() - backfillMonths)
  return from.toISOString()
}

/**
 * The org's frontier for one stream: the **least** deep of the tracked projects.
 *
 * Every org-level total sums across projects, so a total is only as deep as its
 * shallowest contributor — one project stuck a month back makes the org's twelve-month
 * figure a lie regardless of how far the others reached. Hence the latest, not the
 * earliest, of the frontier values.
 *
 * A tracked project with no frontier at all has never had a backward pass, and that is
 * returned as unknown rather than as the depth of its luckier siblings.
 */
function gitlabFrontier(
  cursors: { key: string; value: string | null }[],
  trackedIds: number[],
  suffix: string,
): string | null {
  if (trackedIds.length === 0) return null

  const values: string[] = []
  for (const id of trackedIds) {
    const row = cursors.find((c) => c.key === `project:${id}${suffix}`)
    if (!row?.value) return null
    values.push(row.value)
  }
  return values.sort().at(-1) ?? null
}

/**
 * Whether the source's most recent finished run said it reached the window start.
 *
 * Read off the newest run only. An older run's claim does not survive a shortened
 * window or a newly tracked project, and `backfill_complete` is recomputed from
 * scratch every run, so the latest word is the only word worth having.
 */
function reportedBackfillComplete(
  runs: { source: string; status: string; stats: Record<string, unknown> | null }[],
  source: 'gitlab' | 'jira',
): boolean {
  const latest = runs.find((r) => r.source === source && r.status !== 'running')
  if (!latest) return false
  return Number(latest.stats?.backfill_complete ?? 0) === 1
}

/** Oldest row stored, whatever the walk claims. Null when the table is empty. */
async function earliestRecord(
  db: ReturnType<typeof supabaseAdmin>,
  table: string,
  column: string,
): Promise<string | null> {
  const { data } = await db
    .from(table)
    .select(column)
    .not(column, 'is', null)
    .order(column, { ascending: true })
    .limit(1)
    .maybeSingle()
  return ((data as Record<string, string> | null)?.[column] as string | undefined) ?? null
}

/** Rows landing inside the requested window, for the "on this much" half of the sentence. */
async function rowsInWindow(
  db: ReturnType<typeof supabaseAdmin>,
  table: string,
  column: string,
  range: CoverageRange,
): Promise<number> {
  const { count } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .gte(column, range.from.toISOString())
    .lte(column, range.to.toISOString())
  return count ?? 0
}
