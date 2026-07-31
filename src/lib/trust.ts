/**
 * How much to trust today's numbers.
 *
 * Every confidence signal in this app was already computed somewhere — the
 * attribution banner, the sync banner, the complexity banner, the confidence
 * column on Outliers. What was missing was one place that reads them together and
 * says whether the numbers are quotable. That is `/trust`, and this is the layer
 * underneath it.
 *
 * The rule this module exists to enforce: **a trust page that disagrees with the
 * banner it summarises is worse than no trust page at all.** So the reads the
 * banners do are moved here and the banners call them, rather than the page
 * recomputing the same figure a second way and drifting. `readAttribution` is what
 * `AttributionBanner` uses; `readSourceHealth` is what `getSyncAlerts` is built
 * from; the throughput basis and the per-engineer confidence come straight off the
 * RPC rows so the page cannot second-guess them.
 *
 * The other rule: **an unknown coverage figure is unknown.** Null is not zero and
 * it is not a hundred. The banners are allowed to treat a missing attribution
 * figure as "nothing to warn about" because their job is to interrupt; a page
 * whose whole subject is what we do not know has to say so.
 */

import type { EngineerOutlier, ScoreConfidence } from '@/lib/types/performance'
import type { OrgKpis } from '@/lib/types/metrics'

/** A sync problem worth interrupting someone about. Re-exported from `@/lib/queries`. */
export type SyncAlertLevel = 'warn' | 'bad'

export interface SyncAlert {
  source: string
  level: SyncAlertLevel
  message: string
}

/** 'unknown' is a fourth state and never folded into one of the other three. */
export type TrustLevel = 'ok' | 'warn' | 'bad' | 'unknown'

/**
 * Floors, mirrored from the SQL that applies them so the page can say what a
 * number was measured against rather than only that it was withheld.
 */

/** Below this many observations a median or ratio is withheld by the RPCs. */
export const SAMPLE_FLOOR = 20

/** Deploy metrics are withheld below this share of the period having deploy history. */
export const DEPLOY_COVERAGE_FLOOR = 50

/** Story points are withheld below this share of resolved issues carrying an estimate. */
export const ESTIMATE_COVERAGE_FLOOR = 50

/**
 * Fewer peers than this at a level and there is no median for the cohort to be
 * measured against. Mirrors the RPC's `no_cohort` confidence and the `no median`
 * marker on the cohort strip — a cohort of two is two people compared with
 * themselves.
 */
export const MIN_COHORT = 3

/** Above this, the attribution gap is small enough to be noise. */
export const ATTRIBUTION_NOISE_FLOOR = 95

/** Below this, per-person and per-squad totals are missing enough to mislead. */
export const ATTRIBUTION_BAD = 70

// --- attribution --------------------------------------------------------------

export interface AttributionRead {
  mr: number | null
  commits: number | null
  /** The worse of the two known figures. Null when neither is known. */
  worst: number | null
  /** False when neither figure is known — the gap is unmeasured, not absent. */
  known: boolean
  /** True when one of the two is unknown while the other is not. */
  partial: boolean
  unattributedMrs: number
  unmappedIdentities: number
  /**
   * Whether the gap is worth stating at all. Above the noise floor it is not, and
   * this is what keeps `AttributionBanner` off a page that does not need it.
   */
  material: boolean
  level: TrustLevel
}

/**
 * How much of the collected work reaches a person.
 *
 * Shared with `AttributionBanner` so the banner and the trust page cannot disagree
 * about whether there is a gap or how big it is.
 */
export function readAttribution(kpis: OrgKpis): AttributionRead {
  const mr = kpis.mr_attribution_pct
  const commits = kpis.commit_attribution_pct
  const both = [mr, commits].filter((v): v is number => v !== null)
  const worst = both.length > 0 ? Math.min(...both) : null

  return {
    mr,
    commits,
    worst,
    known: worst !== null,
    partial: both.length === 1,
    unattributedMrs: kpis.unattributed_mrs,
    unmappedIdentities: kpis.unmapped_identities,
    material: worst !== null && worst < ATTRIBUTION_NOISE_FLOOR,
    level:
      worst === null
        ? 'unknown'
        : worst < ATTRIBUTION_BAD
          ? 'bad'
          : worst < ATTRIBUTION_NOISE_FLOOR
            ? 'warn'
            : 'ok',
  }
}

// --- sync freshness -----------------------------------------------------------

/** The columns of `sync_runs` any freshness judgement needs. */
export interface SyncRunFacts {
  source: string
  status: string
  started_at: string
  finished_at: string | null
}

/**
 * How long a `running` row may stay open before it stops meaning "in flight".
 *
 * A serverless invocation cannot outlive `maxDuration`, which is 300s on both cron
 * routes, so a row still open twenty minutes later is not a slow run — it is a run
 * that died between `start()` and `finish()` and can never write its own ending.
 * Generous by a factor of four against the budget so a genuinely slow run is never
 * libelled, and short enough that an abandoned one is visible the same morning.
 *
 * Lives here rather than in `sync/runner.ts` for two reasons. It is a judgement about
 * when a claim stops being believable, which is this module's subject; and this module
 * must stay free of runtime imports so `node --test` can load it directly, which means
 * the dependency has to point this way — `runner.ts` imports the constant, not the
 * other way round.
 */
export const STALE_RUN_AFTER_MS = 20 * 60_000

export interface SourceHealth {
  source: string
  /** False when no run has finished — nothing can be said about this source yet. */
  observed: boolean
  /**
   * A run is genuinely in flight, which says nothing about health either way. False
   * for a row that has been open past `STALE_RUN_AFTER_MS` — see `abandonedRuns`.
   */
  running: boolean
  /**
   * Rows still marked `running` long past any invocation's lifetime. A crashed run
   * that never reached a terminal status, counted rather than believed: left as
   * "in flight" it hides the fact that nothing is running at all.
   */
  abandonedRuns: number
  /** When the oldest abandoned run started, so the table can say how long ago. */
  oldestAbandonedAt: string | null
  lastStatus: string | null
  lastSuccessAt: string | null
  /** Hours since the last successful run finished. Null means none ever has. */
  hoursSinceSuccess: number | null
  finishedRuns: number
  /** Runs that stopped early, back from the most recent — a walk not converging. */
  consecutivePartial: number
  level: TrustLevel
  /** What this source contributes to the sync banner, in the banner's own words. */
  alerts: SyncAlert[]
}

/** The three sources, in the order the banner lists them. */
const SOURCES = ['gitlab', 'jira', 'hibob'] as const

/**
 * Per-source sync health, and the alerts that follow from it.
 *
 * `getSyncAlerts` is this function's alerts flattened, so the banner on every page
 * and the freshness table on `/trust` are the same judgement rendered twice rather
 * than two judgements that happen to agree today.
 */
export function readSourceHealth(runs: SyncRunFacts[], now = Date.now()): SourceHealth[] {
  // Newest first. The caller already orders this way; doing it here as well keeps
  // the function honest in a test and cannot change the result in production.
  const ordered = [...runs].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  )

  return SOURCES.map((source) => {
    // 'all' is a combined run and counts towards every source it covers.
    const forSource = ordered.filter((r) => r.source === source || r.source === 'all')
    const finished = forSource.filter((r) => r.status !== 'running')

    // Open rows split two ways on age, and the split is the whole point: four gitlab
    // rows sat `running` in production for three days, and reading them as "in flight"
    // is what let a scheduler that had stopped firing look like one mid-run.
    const open = forSource.filter((r) => r.status === 'running')
    const abandoned = open.filter((r) => now - new Date(r.started_at).getTime() > STALE_RUN_AFTER_MS)
    const running = open.length > abandoned.length
    const oldestAbandonedAt = abandoned.length > 0 ? (abandoned.at(-1)?.started_at ?? null) : null

    const base = {
      source,
      running,
      abandonedRuns: abandoned.length,
      oldestAbandonedAt,
      finishedRuns: finished.length,
      consecutivePartial: 0,
      alerts: [] as SyncAlert[],
    }

    // An abandoned run is bad news on its own terms and does not depend on anything
    // else being wrong, so it is raised before the branches below can return early.
    const abandonedAlerts: SyncAlert[] =
      abandoned.length === 0
        ? []
        : [
            {
              source,
              level: 'bad',
              message: `${abandoned.length} run${abandoned.length === 1 ? '' : 's'} never reported a result — ${
                abandoned.length === 1 ? 'it has' : 'the oldest has'
              } been marked running for ${Math.round(
                (now - new Date(oldestAbandonedAt!).getTime()) / 3_600_000,
              )} hours`,
            },
          ]

    if (finished.length === 0) {
      return {
        ...base,
        observed: false,
        lastStatus: null,
        lastSuccessAt: null,
        hoursSinceSuccess: null,
        level: (abandonedAlerts.length > 0 ? 'bad' : 'unknown') as TrustLevel,
        alerts: abandonedAlerts,
      }
    }

    const latest = finished[0]
    const lastSuccess = finished.find((r) => r.status === 'success')
    const lastSuccessAt = lastSuccess?.finished_at ?? null
    const hoursSinceSuccess = lastSuccessAt
      ? (now - new Date(lastSuccessAt).getTime()) / 3_600_000
      : null

    // A failed last run is the whole story; the staleness and convergence checks
    // below would only add noise underneath it.
    if (latest.status === 'error') {
      return {
        ...base,
        observed: true,
        lastStatus: latest.status,
        lastSuccessAt,
        hoursSinceSuccess,
        level: 'bad' as TrustLevel,
        alerts: [
          { source, level: 'bad' as SyncAlertLevel, message: 'the last run failed' },
          ...abandonedAlerts,
        ],
      }
    }

    const alerts: SyncAlert[] = [...abandonedAlerts]
    if (hoursSinceSuccess === null) {
      alerts.push({
        source,
        level: 'bad',
        message: `no run has completed yet — ${finished.length} attempt${
          finished.length === 1 ? '' : 's'
        } stopped early`,
      })
    } else if (hoursSinceSuccess > 24) {
      alerts.push({
        source,
        level: hoursSinceSuccess > 72 ? 'bad' : 'warn',
        message: `last completed ${Math.round(hoursSinceSuccess)} hours ago`,
      })
    }

    let consecutivePartial = 0
    for (const run of finished) {
      if (run.status !== 'partial') break
      consecutivePartial += 1
    }
    if (consecutivePartial >= 3) {
      alerts.push({
        source,
        level: 'warn',
        message: `${consecutivePartial} runs in a row stopped early — the backfill may not be advancing`,
      })
    }

    return {
      ...base,
      observed: true,
      lastStatus: latest.status,
      lastSuccessAt,
      hoursSinceSuccess,
      consecutivePartial,
      level: alerts.some((a) => a.level === 'bad')
        ? ('bad' as TrustLevel)
        : alerts.length > 0
          ? ('warn' as TrustLevel)
          : ('ok' as TrustLevel),
      alerts,
    }
  })
}

// --- can the scheduler even run -----------------------------------------------

export interface CronRead {
  configured: boolean
  missing: string[]
  /** Paths and schedules, so the page can name what is not firing. */
  schedules: readonly { path: string; schedule: string; what: string }[]
  level: TrustLevel
}

/**
 * Whether the nightly runs can authenticate.
 *
 * This is the only fact on the trust page that is read from configuration rather
 * than from data, and it earns the exception by being the one failure the data
 * cannot show. Every other signal here is a consequence — "gitlab last completed 72
 * hours ago" is what an unset `CRON_SECRET` *looks* like from inside the database,
 * because a rejected cron writes no row to be stale. Stating the cause next to the
 * symptom is the difference between "the sync is behind" and "the sync will never
 * catch up on its own".
 */
export function readCron(status: { configured: boolean; missing: string[]; schedules: CronRead['schedules'] }): CronRead {
  return { ...status, level: status.configured ? 'ok' : 'bad' }
}

// --- how much of the window was ever collected --------------------------------

/**
 * A backfill that has provably reached the start of its window, or how far back it
 * has got so far.
 *
 * One of these per stream, because the streams do not travel together. A GitLab
 * project's merge requests, deployments and pipelines each carry their own `:oldest`
 * frontier and each hit their page limit at a different depth — deployments soonest,
 * being the most numerous — so "the backfill" is not one number and never was.
 */
export interface StreamFrontier {
  /** Reads as a subject: "Merge requests". */
  label: string
  source: 'gitlab' | 'jira' | 'hibob'
  /**
   * The oldest instant the backward walk has provably reached, from the `:oldest`
   * cursor. Null when no backward pass has recorded one — which is not the same as
   * zero coverage and is not the same as complete.
   */
  reachedBackTo: string | null
  /**
   * True when the source's most recent run reported `backfill_complete`, which is
   * the only evidence that the whole *configured* window was walked. Jira's walk is
   * forward-only and has no frontier, so for Jira this is the only evidence available.
   */
  complete: boolean
  /**
   * Start of the collection window the sync is configured for — `BACKFILL_MONTHS`
   * ago. Needed because "complete" does not mean "covers whatever period the reader
   * selected": a finished twelve-month backfill still leaves a twelve-month view
   * complete and says nothing about a longer one. Coverage is measured against
   * whichever is later, this or the frontier.
   */
  configuredWindowStart: string
  /** Oldest row actually stored, whatever the walk claims. */
  earliestRecordAt: string | null
  /** Rows stored inside the requested window. */
  rowsInWindow: number
  /** What reading this stream over an uncovered window gets you. */
  consequence: string
}

export interface WindowCoverage extends Omit<StreamFrontier, 'consequence'> {
  /** Share of the requested window with collected history behind it, 0-100. */
  coveredPct: number | null
  /** Days of the window walked, and the window's own length, for the sentence. */
  coveredDays: number | null
  windowDays: number
  level: TrustLevel
  consequence: string
}

/**
 * A window is only quotable when essentially all of it was collected. Set just
 * under 100 rather than at it because a frontier written mid-run sits minutes
 * behind the window start it just crossed, and a 99.8% window is a rounding
 * artefact rather than a gap in the history.
 */
export const WINDOW_COVERAGE_FLOOR = 99

/** Below this the window is not a shorter window, it is a misleading one. */
export const WINDOW_COVERAGE_BAD = 90

/**
 * How much of a period each stream actually has history for.
 *
 * The arithmetic is deliberately the crudest thing that cannot lie: the walk has
 * reached back to some instant, and everything between the window start and that
 * instant was never requested. Nothing here infers coverage from row counts, because
 * row counts cannot tell "nobody merged anything that month" apart from "that month
 * was never fetched" — and those two produce identical charts and opposite
 * conclusions. That is the whole reason 86% of merged merge requests landing in the
 * last quarter looked like a productivity story instead of a collection gap.
 *
 * Three outcomes, and the third is the one that matters:
 *  - `complete` — the walk reached the start of the window it was configured for, so
 *    coverage is measured from there. Note this is **not** automatically 100%: a
 *    finished twelve-month backfill covers a twelve-month view and still leaves a
 *    two-year one two thirds empty. Taking "complete" to mean "covers whatever the
 *    reader picked" would reintroduce the assumption in a new place.
 *  - a frontier short of that — the share behind it, and the days it is short.
 *  - no frontier and not complete — **unknown**. Not zero, not a hundred. A stream
 *    nobody has walked backwards is a stream whose depth is unmeasured.
 */
export function readWindowCoverage(
  frontiers: StreamFrontier[],
  range: { from: Date; to: Date },
  now = Date.now(),
): WindowCoverage[] {
  const to = Math.min(range.to.getTime(), now)
  const from = range.from.getTime()
  const windowMs = Math.max(1, to - from)
  const windowDays = Math.round(windowMs / 86_400_000)

  return frontiers.map((f) => {
    const { consequence, ...rest } = f

    // How far back collection provably reaches. A finished backfill reaches its
    // configured window start; an unfinished one reaches its frontier and no further.
    const reachedAt = f.complete
      ? new Date(f.configuredWindowStart).getTime()
      : f.reachedBackTo === null
        ? null
        : new Date(f.reachedBackTo).getTime()

    // A walk that went past the requested window start covers it, whatever it does for
    // longer ones. This is exactly why the 90-day view is sound while 12 months is not.
    const coveredPct =
      reachedAt === null
        ? null
        : reachedAt <= from
          ? 100
          : Math.max(0, Math.min(100, ((to - reachedAt) / windowMs) * 100))

    return {
      ...rest,
      consequence,
      coveredPct,
      coveredDays: coveredPct === null ? null : Math.round((coveredPct / 100) * windowDays),
      windowDays,
      level:
        coveredPct === null
          ? 'unknown'
          : coveredPct >= WINDOW_COVERAGE_FLOOR
            ? 'ok'
            : coveredPct >= WINDOW_COVERAGE_BAD
              ? 'warn'
              : 'bad',
    }
  })
}

// --- what is withheld, and why ------------------------------------------------

/**
 * The guard that decided whether a metric could be reported. Two kinds, because
 * the app withholds for two different reasons: too few observations behind a
 * median, or too little of the period or the field covered at all.
 */
export type Guard =
  | { kind: 'coverage'; pct: number | null; floor: number; of: string }
  | { kind: 'sample'; n: number; floor: number; unit: string }

export interface Withholding {
  metric: string
  /** Reported, or withheld by its guard. Read off the value, never re-derived. */
  withheld: boolean
  guard: Guard
  /** Why this guard exists — the argument, not the arithmetic. */
  because: string
}

/**
 * Every org-level metric that has a guard, and which side of it the metric fell.
 *
 * `withheld` is read from whether the value came back null, not from re-applying
 * the floor in TypeScript. Re-applying it is how a page ends up claiming a metric
 * is available when the RPC withheld it for a reason the page did not model.
 */
export function orgWithholdings(kpis: OrgKpis): Withholding[] {
  const deployGuard = (): Guard => ({
    kind: 'coverage',
    pct: kpis.deploy_coverage_pct,
    floor: DEPLOY_COVERAGE_FLOOR,
    of: 'of the period has deploy history',
  })

  return [
    {
      metric: 'Deploy frequency',
      withheld: kpis.deploys_per_week === null,
      guard: deployGuard(),
      because:
        'A weekly rate extrapolated from a sliver of the window is not a rate — it is the sliver, annualised.',
    },
    {
      metric: 'Change failure rate',
      withheld: kpis.change_failure_pct === null,
      guard: deployGuard(),
      because: 'The denominator is finished deploys, so it inherits the same coverage gap.',
    },
    {
      metric: 'Time to restore',
      withheld: kpis.mttr_hours === null,
      guard: { kind: 'sample', n: kpis.mttr_sample, floor: SAMPLE_FLOOR, unit: 'recovered failures' },
      because:
        'Only failures actually followed by a success are counted, so an unresolved incident cannot quietly shorten the median.',
    },
    {
      metric: 'Story points',
      withheld: kpis.story_points === null,
      guard: {
        kind: 'coverage',
        pct: kpis.story_points_coverage_pct,
        floor: ESTIMATE_COVERAGE_FLOOR,
        of: 'of resolved issues carry an estimate',
      },
      because:
        'A sum over a field a tenth of issues populate moves when people start estimating, not when output changes.',
    },
    {
      metric: 'Lead time for change',
      withheld: kpis.median_cycle_hours === null,
      guard: { kind: 'sample', n: kpis.cycle_sample, floor: SAMPLE_FLOOR, unit: 'merged MRs' },
      because: 'A median of four merge requests is one anecdote in a statistic’s clothes.',
    },
    {
      metric: 'Review wait',
      withheld: kpis.median_review_wait_hours === null,
      guard: { kind: 'sample', n: kpis.review_wait_sample, floor: SAMPLE_FLOOR, unit: 'merged MRs' },
      because: 'Same floor as lead time, so the two can be read against each other.',
    },
    {
      metric: 'Review coverage',
      withheld: kpis.review_coverage_pct === null,
      guard: {
        kind: 'sample',
        n: kpis.review_coverage_sample,
        floor: SAMPLE_FLOOR,
        unit: 'merged MRs',
      },
      because: 'A share is only worth quoting once there are enough merges for it to move.',
    },
    {
      metric: 'Issue cycle time',
      withheld: kpis.median_issue_cycle_hours === null,
      guard: {
        kind: 'sample',
        n: kpis.issue_cycle_sample,
        floor: SAMPLE_FLOOR,
        unit: 'issues with timings',
      },
      because: 'Issues without both timestamps are not counted rather than assumed instant.',
    },
  ]
}

/** Whether a guard cleared, or cannot be judged because its coverage is unknown. */
export function guardLevel(guard: Guard): TrustLevel {
  if (guard.kind === 'coverage') {
    if (guard.pct === null) return 'unknown'
    return guard.pct >= guard.floor ? 'ok' : 'bad'
  }
  return guard.n >= guard.floor ? 'ok' : 'bad'
}

// --- cohorts ------------------------------------------------------------------

export interface CohortRead {
  key: string
  label: string
  people: number
  /**
   * How many of `people` actually defined the median. Since
   * `0028_tenure_normalisation.sql` an engineer below half a window of employment
   * is scored but left out of it, so a cohort of nine can rest on eight.
   */
  scoredPeople: number
  /**
   * False below `MIN_COHORT`, counted on `scoredPeople` rather than on `people` —
   * three peers on paper of whom one is eleven days old is a median over two, and
   * that is the number the guard is about.
   */
  hasMedian: boolean
  thin: number
  noCohort: number
  /** Scored but out of the median: a partial window, or a start date nobody has. */
  partialWindow: number
}

export interface ScoredRead {
  /** Rows the RPC returned at all. */
  total: number
  /** Rows carrying a score. A dimension with no data drops out; all four missing is no score. */
  scored: number
  byConfidence: Record<ScoreConfidence, number>
  cohorts: CohortRead[]
  /** Straight off the rows, which is what the complexity banner reads too. */
  throughputBasis: EngineerOutlier['throughput_basis'] | null
  /** Share of the org's merge requests with a measured size. Null when unknown. */
  orgSizedMrPct: number | null
}

/**
 * The confidence column on Outliers, counted rather than listed.
 *
 * Cohort size comes from `peers_at_level`, which is what the ranked table already
 * prints as "#n of m at level", so a cohort here is the same cohort there.
 */
export function readScored(rows: EngineerOutlier[]): ScoredRead {
  const byConfidence: Record<ScoreConfidence, number> = {
    high: 0,
    thin: 0,
    no_cohort: 0,
    partial_window: 0,
  }
  const cohorts = new Map<string, CohortRead>()

  for (const row of rows) {
    byConfidence[row.score_confidence] += 1

    const existing = cohorts.get(row.seniority_key)
    const cohort: CohortRead = existing ?? {
      key: row.seniority_key,
      label: row.seniority_label ?? row.seniority_key,
      people: row.peers_at_level,
      scoredPeople: row.cohort_scored_peers,
      hasMedian: row.cohort_scored_peers >= MIN_COHORT,
      thin: 0,
      noCohort: 0,
      partialWindow: 0,
    }
    if (row.score_confidence === 'thin') cohort.thin += 1
    if (row.score_confidence === 'no_cohort') cohort.noCohort += 1
    if (row.score_confidence === 'partial_window') cohort.partialWindow += 1
    cohorts.set(row.seniority_key, cohort)
  }

  const first = rows[0]
  return {
    total: rows.length,
    scored: rows.filter((r) => r.score !== null).length,
    byConfidence,
    cohorts: [...cohorts.values()],
    throughputBasis: first?.throughput_basis ?? null,
    orgSizedMrPct: first?.org_sized_mr_pct ?? null,
  }
}

// --- the verdict --------------------------------------------------------------

export interface TrustClause {
  /** Anchor of the section that shows the working for this clause. */
  section: string
  level: 'warn' | 'bad' | 'unknown'
  /** Reads as a noun phrase, so it can be dropped into a sentence. */
  text: string
}

export interface TrustVerdict {
  level: 'clear' | 'caveated' | 'blocked'
  /** The one line a reader needs before quoting any of this to another human. */
  headline: string
  /** What produced the verdict, worst first. Things that are wrong today. */
  clauses: TrustClause[]
  /**
   * Things that are true every day and cannot be fixed, only known — the
   * denominator, chiefly. Kept out of `clauses` on purpose: a verdict carrying a
   * permanent caveat is a verdict nobody reads, and a definition is not a defect.
   */
  notes: TrustClause[]
}

export interface VerdictInput {
  attribution: AttributionRead
  sources: SourceHealth[]
  withholdings: Withholding[]
  scored: ScoredRead
  /** Directory headcount versus the headcount the metrics are built on. */
  people: { directory: number; inMetrics: number }
  /**
   * How much of the selected window each stream has history for, and the window's
   * own name so the clause can say which view is short.
   *
   * Optional, and optional on purpose rather than as a convenience: a caller that
   * has not measured coverage must produce a verdict with nothing to say about it.
   * Defaulting an unmeasured window to "covered" is precisely the assumption this
   * whole section exists to remove.
   */
  windows?: { label: string; coverage: WindowCoverage[] }
  /** Whether the scheduler can authenticate. Omitted where it cannot be read. */
  cron?: CronRead
}

/**
 * The verdict, and every clause behind it.
 *
 * Deliberately ordered worst-first and deliberately short: the headline has to be
 * quotable on its own, because a reader who only takes one line off this page will
 * take the first one. Nothing here invents a threshold — each clause fires off a
 * judgement already made elsewhere in the app.
 */
export function readVerdict(input: VerdictInput): TrustVerdict {
  const { attribution, sources, withholdings, scored, people, windows, cron } = input
  const clauses: TrustClause[] = []

  // 0. A scheduler that cannot authenticate outranks every staleness figure below,
  //    because it is their cause. "gitlab last completed 72 hours ago" invites you to
  //    wait for tonight's run; there is no tonight's run.
  if (cron && !cron.configured) {
    clauses.push({
      section: 'freshness',
      level: 'bad',
      text: `the scheduled runs cannot authenticate — ${cron.missing.join(' and ')} ${
        cron.missing.length === 1 ? 'is' : 'are'
      } unset, so ${cron.schedules
        .map((s) => s.path)
        .join(' and ')} are refused before they start and nothing is recorded when they are`,
    })
  }

  // 1. A broken source makes every number wrong in the same believable direction,
  //    so it outranks everything else on the page.
  for (const source of sources.filter((s) => s.level === 'bad')) {
    clauses.push({
      section: 'freshness',
      level: 'bad',
      text: `${source.source} is ${source.alerts[0]?.message ?? 'not healthy'}`,
    })
  }

  // 1b. A window the collection never reached is the one failure that looks like a
  //     finding: the missing months read as months when less was shipped. Ranked with
  //     the broken sources rather than with the caveats because a reader comparing
  //     this quarter with last is comparing a walked window with an unwalked one.
  if (windows) {
    // Worst first, and a *measured* shortfall outranks an unmeasured one. "51 of 365
    // days of deployments" is a finding a reader can act on; "pipeline depth is
    // unknown" is a gap in our knowledge of a gap. Sorting unknowns first — which
    // `?? -1` would do — buries the concrete statement under the vaguer one.
    const short = [...windows.coverage]
      .filter((c) => c.level === 'bad' || c.level === 'unknown')
      .sort((a, b) => (a.coveredPct ?? Infinity) - (b.coveredPct ?? Infinity))
    const worstShort = short[0]
    if (worstShort) {
      clauses.push({
        section: 'depth',
        level: worstShort.level === 'unknown' ? 'unknown' : 'bad',
        text:
          worstShort.coveredPct === null
            ? `how far back ${worstShort.label.toLowerCase()} were ever collected is unknown, so "${windows.label}" may be a shorter window than it says`
            : `"${windows.label}" holds only ${worstShort.coveredDays} of ${worstShort.windowDays} days of ${worstShort.label.toLowerCase()}${
                short.length > 1 ? ` (and ${short.length - 1} other stream${short.length === 2 ? '' : 's'} are short too)` : ''
              }, so the missing months read as quiet ones`,
      })
    }

    // Short of the floor but not badly: worth a line, because a reader who takes only
    // the headline should not be told a 94%-collected window is whole.
    const nearlyThere = windows.coverage.filter((c) => c.level === 'warn')
    if (!worstShort && nearlyThere.length > 0) {
      const worst = nearlyThere.sort((a, b) => (a.coveredPct ?? 0) - (b.coveredPct ?? 0))[0]
      clauses.push({
        section: 'depth',
        level: 'warn',
        text: `${worst.label.toLowerCase()} cover ${worst.coveredDays} of the window's ${worst.windowDays} days, so the earliest weeks of "${windows.label}" are thinner than the rest`,
      })
    }
  }

  // 2. Attribution decides whether any per-person or per-squad total is a total.
  if (attribution.level === 'unknown') {
    clauses.push({
      section: 'coverage',
      level: 'unknown',
      text: 'how much work reaches a named engineer is unknown for this period',
    })
  } else if (attribution.level === 'bad') {
    clauses.push({
      section: 'coverage',
      level: 'bad',
      text: `only ${attribution.worst!.toFixed(1)}% of work reaches a named engineer, so per-person totals are well short`,
    })
  } else if (attribution.material) {
    clauses.push({
      section: 'coverage',
      level: 'warn',
      text: `${attribution.worst!.toFixed(1)}% of work reaches a named engineer, so per-person and per-squad totals are lower bounds`,
    })
  }

  // 3. Stale but not broken.
  const stale = sources.filter((s) => s.level === 'warn')
  if (stale.length > 0) {
    clauses.push({
      section: 'freshness',
      level: 'warn',
      text:
        stale.length === sources.length
          ? 'every source is more than a day behind'
          : `${stale.map((s) => s.source).join(' and ')} ${stale.length === 1 ? 'is' : 'are'} behind`,
    })
  }

  const unobserved = sources.filter((s) => !s.observed)
  if (unobserved.length > 0) {
    clauses.push({
      section: 'freshness',
      level: 'unknown',
      text: `${unobserved.map((s) => s.source).join(' and ')} has never finished a run, so its freshness is unknown`,
    })
  }

  // 4. Metrics that are simply not on the page today.
  const withheld = withholdings.filter((w) => w.withheld)
  if (withheld.length > 0) {
    clauses.push({
      section: 'withheld',
      level: 'warn',
      text: `${withheld.length} org ${withheld.length === 1 ? 'metric is' : 'metrics are'} withheld (${withheld
        .map((w) => w.metric.toLowerCase())
        .join(', ')})`,
    })
  }

  // 5. Throughput's unit, which changes by itself as the size backfill advances.
  if (scored.throughputBasis === 'count') {
    clauses.push({
      section: 'withheld',
      level: 'warn',
      text: 'throughput counts merge requests rather than weighting them, because too few have a measured size',
    })
  }

  // 6. Scores that exist but should not be leaned on.
  const shaky = scored.byConfidence.thin + scored.byConfidence.no_cohort
  if (shaky > 0) {
    clauses.push({
      section: 'cohorts',
      level: 'warn',
      text: `${shaky} of ${scored.total} scored engineers ${shaky === 1 ? 'has' : 'have'} thin data or no cohort behind their score`,
    })
  }

  // Not a caveat: the denominator is a definition, and it is the same definition
  // every day. It is still the most common way a rate here gets misquoted, so it is
  // stated — just not as something that could be put right.
  const notes: TrustClause[] = []
  if (people.inMetrics < people.directory) {
    notes.push({
      section: 'people',
      level: 'warn',
      text: `every per-engineer rate divides by ${people.inMetrics}, not by the ${people.directory} people in the directory`,
    })
  }

  const worst = clauses[0]
  const level: TrustVerdict['level'] =
    clauses.some((c) => c.level === 'bad')
      ? 'blocked'
      : clauses.length > 0
        ? 'caveated'
        : 'clear'

  const headline =
    level === 'clear'
      ? 'Quotable as they stand — every source is current and nothing is being withheld.'
      : level === 'blocked'
        ? `Do not quote today's numbers before checking one thing: ${worst.text}.`
        : `Quotable with ${clauses.length === 1 ? 'one caveat' : `${clauses.length} caveats`}, the largest being that ${worst.text}.`

  return { level, headline, clauses, notes }
}
