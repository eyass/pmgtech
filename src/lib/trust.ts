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

export interface SourceHealth {
  source: string
  /** False when no run has finished — nothing can be said about this source yet. */
  observed: boolean
  /** A run is in flight right now, which says nothing about health either way. */
  running: boolean
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
    const running = forSource.some((r) => r.status === 'running')

    const base = {
      source,
      running,
      finishedRuns: finished.length,
      consecutivePartial: 0,
      alerts: [] as SyncAlert[],
    }

    if (finished.length === 0) {
      return {
        ...base,
        observed: false,
        lastStatus: null,
        lastSuccessAt: null,
        hoursSinceSuccess: null,
        level: 'unknown' as TrustLevel,
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
        alerts: [{ source, level: 'bad' as SyncAlertLevel, message: 'the last run failed' }],
      }
    }

    const alerts: SyncAlert[] = []
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
  const { attribution, sources, withholdings, scored, people } = input
  const clauses: TrustClause[] = []

  // 1. A broken source makes every number wrong in the same believable direction,
  //    so it outranks everything else on the page.
  for (const source of sources.filter((s) => s.level === 'bad')) {
    clauses.push({
      section: 'freshness',
      level: 'bad',
      text: `${source.source} is ${source.alerts[0]?.message ?? 'not healthy'}`,
    })
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
