/**
 * Reading a series of stored scores without inventing continuity.
 *
 * `0025_score_snapshots.sql` writes down what a score *was*, so the app can finally
 * say whether somebody moved. That is a new chance to lie in two specific ways, and
 * both of them are closed here rather than in the charts, because a rule that lives
 * in a component is a rule nobody can test — the same reason `chart-scale.ts` and
 * `rank-bands.ts` exist next to the charts instead of inside them.
 *
 *   1. **A difference smaller than the noise is not a movement.** The gate is
 *      `MATERIAL_SCORE_GAP` from `rank-bands.ts` — one interquartile range of a
 *      cohort, 15 points — imported rather than restated, because a second
 *      threshold would eventually disagree with the first and each would look
 *      principled on its own page.
 *   2. **A difference across a `definition_version` boundary is not a difference at
 *      all.** 0023 and 0024 both rewrote every historical score; a snapshot taken
 *      under one formula and a snapshot taken under the next are two questions each
 *      answered once. Those get their own state — never "no change", never an
 *      arrow, never a connected line segment.
 *
 * And the state that matters most today: with a single capture in the database there
 * is *no* trend, and there is no backfill that could make one (see the migration's
 * header). `scoreTrend` returns `one-capture` for that, which the charts must render
 * as an explicit absence. A flat line drawn through one point claims measured
 * stability that nobody measured.
 */

// Relative and extensioned for the same reason as `radar-geometry.ts` and
// `targets.ts`: `node --test` strips types but does not resolve the `@/` alias, and
// MATERIAL_SCORE_GAP is a value rather than a type.
import { MATERIAL_SCORE_GAP, materiallyApart } from './rank-bands.ts'
import type { ScoreConfidence } from './types/performance.ts'

// --- the shape of a series ---------------------------------------------------

/**
 * One capture of one subject — an engineer or a squad, since the snapshot tables
 * carry the same fields at both altitudes and the charts are shared.
 *
 * `definitionVersion` is required and has no default. A point that cannot say which
 * formula produced it would be silently comparable with everything, which is the
 * exact failure `definition_version` was added to prevent.
 */
export interface ScorePoint {
  /** The day the measured window ended, `YYYY-MM-DD`. The series' x value. */
  capturedFor: string
  definitionVersion: string
  /** Null means "captured, not scored" — never zero. */
  score: number | null
  /** Dense `rank_in_org`, so ties share a number. Null when the row had no rank. */
  rankInOrg: number | null
  confidence: ScoreConfidence | null
  confidenceReason: string | null
}

export interface ScoreSeries {
  id: string
  name: string
  /** Short enough to sit beside a line without colliding with it. */
  shortName: string
  /** Ascending by `capturedFor`. */
  points: ScorePoint[]
}

/** Ascending by capture day. ISO dates sort correctly as strings. */
export function sortPoints(points: readonly ScorePoint[]): ScorePoint[] {
  return [...points].sort((a, b) =>
    a.capturedFor < b.capturedFor ? -1 : a.capturedFor > b.capturedFor ? 1 : 0,
  )
}

/**
 * Group flat snapshot rows into one series per subject.
 *
 * Generic over the row type so `lib/queries.ts` can own the database shape and this
 * module can stay free of any Supabase import — the same split as `targets.ts`.
 */
export function buildSeries<T>(
  rows: readonly T[],
  read: (row: T) => { id: string; name: string; shortName: string; point: ScorePoint },
): ScoreSeries[] {
  const byId = new Map<string, ScoreSeries>()
  for (const row of rows) {
    const { id, name, shortName, point } = read(row)
    const existing = byId.get(id)
    if (existing) existing.points.push(point)
    else byId.set(id, { id, name, shortName, points: [point] })
  }
  const series = [...byId.values()]
  for (const s of series) s.points = sortPoints(s.points)
  return series
}

/** Every capture day across every subject, ascending. The shared x axis. */
export function captureDays(series: readonly ScoreSeries[]): string[] {
  const days = new Set<string>()
  for (const s of series) for (const p of s.points) days.add(p.capturedFor)
  return [...days].sort()
}

/**
 * Consecutive captures that share a `definition_version`.
 *
 * This is what a chart draws: **one polyline per run, never one across runs.** A
 * line joining two formulas asserts a path between them, and there was none — the
 * number changed because the question did. The break is the honest mark.
 */
export function versionRuns(points: readonly ScorePoint[]): ScorePoint[][] {
  const runs: ScorePoint[][] = []
  for (const point of sortPoints(points)) {
    const open = runs[runs.length - 1]
    if (open && open[open.length - 1]!.definitionVersion === point.definitionVersion) open.push(point)
    else runs.push([point])
  }
  return runs
}

/**
 * The capture days a version boundary falls *before*, so a chart can draw the break
 * where it actually happened rather than at an arbitrary edge.
 */
export function versionBoundaries(points: readonly ScorePoint[]): string[] {
  const sorted = sortPoints(points)
  const out: string[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.definitionVersion !== sorted[i - 1]!.definitionVersion) {
      out.push(sorted[i]!.capturedFor)
    }
  }
  return out
}

// --- the trend ---------------------------------------------------------------

/** A scored point: the score is present, so it can be an endpoint of a delta. */
export type ScoredPoint = ScorePoint & { score: number }

/**
 * What a series is allowed to say about itself.
 *
 * Five states, and three of them are refusals. That ratio is the point: the data in
 * this database supports a delta far less often than a chart would like to draw one,
 * so every reason to refuse gets its own state rather than collapsing into a shrug
 * that reads like "no change".
 */
export type Trend =
  /** Nothing captured, or nothing captured with a score. */
  | { kind: 'no-history'; captures: 0 }
  /**
   * Exactly one scored capture. Not "stable" — unmeasured. There is deliberately no
   * backfill, so this is where every series starts and the charts must say so.
   */
  | { kind: 'one-capture'; captures: 1; at: ScoredPoint }
  /**
   * The most recent capture is the first under its formula. There are earlier scores
   * and they are not comparable to it, so there is no delta to draw in either
   * direction.
   */
  | {
      kind: 'redefined'
      captures: number
      at: ScoredPoint
      /** The last capture under the previous formula, for naming what changed. */
      previous: ScoredPoint
    }
  /** Two comparable captures whose difference does not clear one interquartile range. */
  | {
      kind: 'immaterial'
      captures: number
      from: ScoredPoint
      to: ScoredPoint
      /** Signed, and shown only alongside the statement that it is inside the noise. */
      change: number
      gap: number
    }
  /** A movement large enough to be worth a conversation. */
  | {
      kind: 'material'
      captures: number
      from: ScoredPoint
      to: ScoredPoint
      change: number
      direction: 'up' | 'down'
      gap: number
    }

function scoredOnly(points: readonly ScorePoint[]): ScoredPoint[] {
  return sortPoints(points).filter(
    (p): p is ScoredPoint => p.score !== null && Number.isFinite(p.score),
  )
}

/**
 * The trailing stretch of captures that can be compared with the newest one:
 * consecutive, scored, and all under the newest capture's `definition_version`.
 *
 * Strictly trailing and strictly consecutive, which is the conservative reading and
 * deliberately so. If a formula changed and later changed back, the two captures at
 * either end carry the same version string and are arguably comparable — but a
 * boundary still lies between them, and refusing costs a delta while accepting risks
 * drawing one across a formula this app cannot see. The refusal is visible on
 * screen, so the cost is paid in the open.
 */
export function comparableRun(points: readonly ScorePoint[]): ScoredPoint[] {
  const all = scoredOnly(points)
  if (all.length === 0) return []
  const version = all[all.length - 1]!.definitionVersion
  const run: ScoredPoint[] = []
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i]!.definitionVersion !== version) break
    run.unshift(all[i]!)
  }
  return run
}

/**
 * What this series can honestly claim, from its first comparable capture to its
 * latest one.
 *
 * First-to-last within the comparable run rather than last-two: a reader looking at
 * a sparkline is asking "where has this gone", and the answer to that is the span
 * the line covers. Both endpoints are returned so the caller can name the dates
 * rather than implying the delta covers the whole chart.
 */
export function scoreTrend(points: readonly ScorePoint[]): Trend {
  const all = scoredOnly(points)
  if (all.length === 0) return { kind: 'no-history', captures: 0 }
  if (all.length === 1) return { kind: 'one-capture', captures: 1, at: all[0]! }

  const run = comparableRun(points)
  const latest = all[all.length - 1]!
  if (run.length < 2) {
    return { kind: 'redefined', captures: all.length, at: latest, previous: all[all.length - 2]! }
  }

  const from = run[0]!
  const to = run[run.length - 1]!
  const change = to.score - from.score
  if (!materiallyApart(from.score, to.score)) {
    return { kind: 'immaterial', captures: run.length, from, to, change, gap: MATERIAL_SCORE_GAP }
  }
  return {
    kind: 'material',
    captures: run.length,
    from,
    to,
    change,
    direction: change > 0 ? 'up' : 'down',
    gap: MATERIAL_SCORE_GAP,
  }
}

/** `2026-07-31` → `31 Jul`. Kept here so every trend readout dates itself the same way. */
export function captureLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** A signed score difference, with a true minus sign because these sit in tabular figures. */
export function signed(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`
}

/**
 * One sentence per state, written once so the sparkline, the bump chart and the
 * movers list cannot describe the same refusal three different ways.
 *
 * Every string states what is missing rather than what is unavailable — "history
 * starts here" instead of "no data", because the reason is a fact about this product
 * (the capture only just started, and nothing can be reconstructed) rather than an
 * outage.
 */
export function describeTrend(trend: Trend): string {
  switch (trend.kind) {
    case 'no-history':
      return 'No score has been captured for this period yet, so there is nothing to compare.'
    case 'one-capture':
      return `One capture, ${captureLabel(trend.at.capturedFor)}. A trend needs two, and there is no backfill — history starts here.`
    case 'redefined':
      return `The scoring formula changed between ${captureLabel(trend.previous.capturedFor)} (${trend.previous.definitionVersion}) and ${captureLabel(trend.at.capturedFor)} (${trend.at.definitionVersion}). Those are two different measurements, so no change can be stated across them.`
    case 'immaterial':
      return `${signed(trend.change)} points between ${captureLabel(trend.from.capturedFor)} and ${captureLabel(trend.to.capturedFor)}, inside the ${trend.gap}-point interquartile range this app treats as noise. Not a movement.`
    case 'material':
      return `${signed(trend.change)} points between ${captureLabel(trend.from.capturedFor)} and ${captureLabel(trend.to.capturedFor)}, clear of the ${trend.gap}-point noise floor.`
  }
}

/** A short state label for a cramped spot such as a table cell. */
export function trendBadge(trend: Trend): string {
  switch (trend.kind) {
    case 'no-history':
      return 'no capture'
    case 'one-capture':
      return 'first capture'
    case 'redefined':
      return 'new definition'
    case 'immaterial':
      return 'no material change'
    case 'material':
      return `${signed(trend.change)} pts`
  }
}

// --- movers ------------------------------------------------------------------

/**
 * A rank that moved for a reason the score can support.
 *
 * Both the rank change and the score change are carried, because the rank is the
 * headline and the score is the evidence: a dense ranking over scores a fraction of
 * an interquartile range apart reshuffles on nothing at all, and the score delta is
 * what says whether this one did.
 */
export interface RankMove {
  id: string
  name: string
  shortName: string
  rankFrom: number
  rankTo: number
  /** Positive means climbed — a *smaller* rank number. */
  rankChange: number
  scoreFrom: number
  scoreTo: number
  scoreChange: number
  fromDay: string
  toDay: string
  definitionVersion: string
  /** False for thin data or no cohort at the latest capture — drawn hollow. */
  solid: boolean
}

/** A score that moved materially while the rank stayed exactly where it was. */
export interface HeldRank {
  id: string
  name: string
  rank: number
  scoreChange: number
}

/** A rank that moved on a score change too small to justify it. */
export interface GatedMove {
  id: string
  name: string
  shortName: string
  rankFrom: number
  rankTo: number
  rankChange: number
  scoreChange: number
}

export interface MoversResult {
  climbers: RankMove[]
  fallers: RankMove[]
  /**
   * Ranks that moved without a material score change. Named rather than counted,
   * because "four ranks moved and none of them mean anything" is the finding a tight
   * cohort produces, and hiding it would leave the empty list looking broken.
   */
  gated: GatedMove[]
  /**
   * Material score movement that did not move the rank at all — bottom of the
   * ranking climbing twenty points and still being bottom. Reported rather than
   * dropped: a movers list built only on rank silently loses the largest genuine
   * change on the page whenever it happens at either end of the ordering.
   */
  heldRank: HeldRank[]
  /** Subjects whose latest capture is under a new formula. Names, for stating it. */
  redefined: string[]
  /** Subjects without two comparable captures — the state every series starts in. */
  tooShort: number
  /** Subjects whose comparable captures carry no rank, so no rank move exists. */
  unranked: number
  /** Distinct capture days seen across all subjects. Under two, nothing can move. */
  captures: number
  /** The worst rank seen, so every mini slope in the list shares one axis. */
  maxRank: number
  gap: number
}

/**
 * The biggest climbers and fallers, gated on the score rather than on the rank.
 *
 * The gate is the whole design. A rank is an ordering over a composite whose spread
 * in this org is 6.6 points across eleven of fourteen people, so ranks move every
 * capture whether or not anything happened. Requiring the underlying score to clear
 * one interquartile range means this list is short, often empty, and true — and when
 * it is empty the caller has `gated` and can say *why* instead of falling back to
 * the largest available noise.
 */
export function rankMovers(series: readonly ScoreSeries[], limit = 5): MoversResult {
  const climbers: RankMove[] = []
  const fallers: RankMove[] = []
  const gated: GatedMove[] = []
  const heldRank: HeldRank[] = []
  const redefined: string[] = []
  let tooShort = 0
  let unranked = 0
  let maxRank = 1

  for (const subject of series) {
    for (const point of subject.points) {
      if (point.rankInOrg !== null) maxRank = Math.max(maxRank, point.rankInOrg)
    }

    const trend = scoreTrend(subject.points)
    if (trend.kind === 'no-history' || trend.kind === 'one-capture') {
      tooShort += 1
      continue
    }
    if (trend.kind === 'redefined') {
      redefined.push(subject.name)
      continue
    }

    const { from, to } = trend
    if (from.rankInOrg === null || to.rankInOrg === null) {
      unranked += 1
      continue
    }

    const rankChange = from.rankInOrg - to.rankInOrg
    if (rankChange === 0) {
      if (trend.kind === 'material') {
        heldRank.push({
          id: subject.id,
          name: subject.name,
          rank: to.rankInOrg,
          scoreChange: trend.change,
        })
      }
      continue
    }

    if (trend.kind === 'immaterial') {
      gated.push({
        id: subject.id,
        name: subject.name,
        shortName: subject.shortName,
        rankFrom: from.rankInOrg,
        rankTo: to.rankInOrg,
        rankChange,
        scoreChange: trend.change,
      })
      continue
    }

    const move: RankMove = {
      id: subject.id,
      name: subject.name,
      shortName: subject.shortName,
      rankFrom: from.rankInOrg,
      rankTo: to.rankInOrg,
      rankChange,
      scoreFrom: from.score,
      scoreTo: to.score,
      scoreChange: trend.change,
      fromDay: from.capturedFor,
      toDay: to.capturedFor,
      definitionVersion: to.definitionVersion,
      solid: to.confidence === 'high',
    }
    if (rankChange > 0) climbers.push(move)
    else fallers.push(move)
  }

  // Ties broken by score movement then by name, so a permuted input gives an
  // identical list rather than one that reshuffles between renders.
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  climbers.sort(
    (a, b) => b.rankChange - a.rankChange || b.scoreChange - a.scoreChange || byName(a, b),
  )
  fallers.sort((a, b) => a.rankChange - b.rankChange || a.scoreChange - b.scoreChange || byName(a, b))
  gated.sort((a, b) => Math.abs(b.rankChange) - Math.abs(a.rankChange) || byName(a, b))
  heldRank.sort((a, b) => Math.abs(b.scoreChange) - Math.abs(a.scoreChange) || byName(a, b))

  return {
    climbers: climbers.slice(0, limit),
    fallers: fallers.slice(0, limit),
    gated,
    heldRank,
    redefined,
    tooShort,
    unranked,
    captures: captureDays(series).length,
    maxRank,
    gap: MATERIAL_SCORE_GAP,
  }
}
