/**
 * Score history: turning snapshot rows into something a chart may honestly draw.
 *
 * `0025_score_snapshots.sql` stamps every captured score with the
 * `definition_version` that produced it, and says why in its header: a delta across
 * a version boundary "is not a delta; it is two different questions answered once
 * each". Two scoring inputs have already changed under this app — 0023 moved
 * throughput to complexity-weighted merge requests, 0029 moved five volume inputs
 * to per-week rates — and each time every score shifted for reasons that had
 * nothing to do with how anyone worked.
 *
 * So the drawing rule is: **a line may only connect two points computed the same
 * way.** Everything in this module exists to enforce that, which is why the
 * segmenting is here as pure functions rather than inline in a chart component —
 * the rule is the thing worth testing, and it is easy to get wrong in a way that
 * looks fine.
 */

export interface ScoreSnapshot {
  captured_for: string
  definition_version: string
  score: number | null
  rank_in_org: number | null
  rank_at_level: number | null
  peers_at_level: number | null
  throughput_score: number | null
  flow_score: number | null
  quality_score: number | null
  collaboration_score: number | null
  score_confidence: string | null
  standing: string | null
}

export interface EngineerScoreSnapshot extends ScoreSnapshot {
  engineer_id: string
  full_name: string | null
  seniority_key: string | null
}

/** A run of consecutive captures that share one definition_version. */
export interface HistorySegment {
  definitionVersion: string
  points: ScoreSnapshot[]
}

/** Oldest first. Snapshots arrive in whatever order the query returned them. */
export function sortByDate<T extends { captured_for: string }>(points: T[]): T[] {
  return [...points].sort((a, b) => a.captured_for.localeCompare(b.captured_for))
}

/**
 * Split a series into runs of one definition_version, oldest first.
 *
 * A chart draws one line per segment and leaves a visible gap between them. It is
 * deliberately *not* one line with a styled joint: a dashed segment still reads as
 * continuous, and the point is that no continuity exists to read.
 */
export function segmentByDefinition(points: ScoreSnapshot[]): HistorySegment[] {
  const sorted = sortByDate(points)
  const segments: HistorySegment[] = []

  for (const point of sorted) {
    const last = segments[segments.length - 1]
    if (last && last.definitionVersion === point.definition_version) {
      last.points.push(point)
    } else {
      segments.push({ definitionVersion: point.definition_version, points: [point] })
    }
  }

  return segments
}

/**
 * The two most recent captures that share a definition_version.
 *
 * Returns null when there is nothing honest to compare — fewer than two captures,
 * or a most-recent capture whose predecessor was computed under a different
 * formula. The caller shows "no comparable history" rather than a made-up zero,
 * because a delta of 0 and no delta at all mean very different things.
 */
export function comparablePair(
  points: ScoreSnapshot[],
): { previous: ScoreSnapshot; latest: ScoreSnapshot } | null {
  const sorted = sortByDate(points)
  if (sorted.length < 2) return null

  const latest = sorted[sorted.length - 1]
  const previous = sorted[sorted.length - 2]

  if (previous.definition_version !== latest.definition_version) return null
  return { previous, latest }
}

/**
 * True when the series spans more than one definition_version, so a reader can be
 * told the chart is not one continuous measurement.
 */
export function crossesDefinitionBoundary(points: ScoreSnapshot[]): boolean {
  if (points.length === 0) return false
  const first = points[0].definition_version
  return points.some((p) => p.definition_version !== first)
}

export interface Mover {
  engineerId: string
  fullName: string
  seniorityKey: string | null
  scoreFrom: number | null
  scoreTo: number | null
  scoreDelta: number | null
  rankFrom: number | null
  rankTo: number | null
  /** Positive means improved, i.e. moved towards rank 1. */
  rankDelta: number | null
  confidence: string | null
  capturedFor: string
  previousCapturedFor: string
}

/**
 * Biggest movers between each engineer's two most recent comparable captures.
 *
 * Two things worth knowing about the shape of this:
 *
 * - **Comparability is decided per engineer, not once for the org.** An engineer
 *   hired last week has a shorter series than everyone else, and excluding the
 *   whole org from comparison because one person lacks a pair would throw away
 *   most of the answer.
 * - **Rank delta is sign-flipped from the raw numbers.** Rank 8 to rank 3 is an
 *   improvement of five, not minus five, and every consumer of this wants the
 *   direction a human would say out loud.
 */
export function computeMovers(rows: EngineerScoreSnapshot[]): Mover[] {
  const byEngineer = new Map<string, EngineerScoreSnapshot[]>()

  for (const row of rows) {
    const existing = byEngineer.get(row.engineer_id)
    if (existing) existing.push(row)
    else byEngineer.set(row.engineer_id, [row])
  }

  const movers: Mover[] = []

  for (const [engineerId, points] of byEngineer) {
    const pair = comparablePair(points)
    if (!pair) continue

    const latest = pair.latest as EngineerScoreSnapshot
    const previous = pair.previous as EngineerScoreSnapshot

    const scoreDelta =
      latest.score !== null && previous.score !== null
        ? Number((latest.score - previous.score).toFixed(1))
        : null

    const rankDelta =
      latest.rank_in_org !== null && previous.rank_in_org !== null
        ? previous.rank_in_org - latest.rank_in_org
        : null

    // Nothing moved and nothing can be said — not worth a row in a "movers" list.
    if (scoreDelta === null && rankDelta === null) continue

    movers.push({
      engineerId,
      fullName: latest.full_name ?? 'Unknown',
      seniorityKey: latest.seniority_key,
      scoreFrom: previous.score,
      scoreTo: latest.score,
      scoreDelta,
      rankFrom: previous.rank_in_org,
      rankTo: latest.rank_in_org,
      rankDelta,
      confidence: latest.score_confidence,
      capturedFor: latest.captured_for,
      previousCapturedFor: previous.captured_for,
    })
  }

  return movers.sort((a, b) => Math.abs(b.scoreDelta ?? 0) - Math.abs(a.scoreDelta ?? 0))
}

/** One engineer's rank across captures, for the bump chart. */
export interface RankSeries {
  engineerId: string
  fullName: string
  seniorityKey: string | null
  points: { capturedFor: string; rank: number; definitionVersion: string }[]
}

/**
 * Group snapshot rows into one rank series per engineer, dropping captures with no
 * rank. Series with a single point are kept: on a bump chart a lone dot correctly
 * says "we have one reading for this person", where dropping them would imply they
 * were not measured at all.
 */
export function toRankSeries(rows: EngineerScoreSnapshot[]): RankSeries[] {
  const byEngineer = new Map<string, RankSeries>()

  for (const row of sortByDate(rows)) {
    if (row.rank_in_org === null) continue

    const existing = byEngineer.get(row.engineer_id)
    const point = {
      capturedFor: row.captured_for,
      rank: row.rank_in_org,
      definitionVersion: row.definition_version,
    }

    if (existing) {
      existing.points.push(point)
    } else {
      byEngineer.set(row.engineer_id, {
        engineerId: row.engineer_id,
        fullName: row.full_name ?? 'Unknown',
        seniorityKey: row.seniority_key,
        points: [point],
      })
    }
  }

  // Best current rank first, so the chart's legend reads top-down like the ranking.
  return [...byEngineer.values()].sort((a, b) => {
    const aLast = a.points[a.points.length - 1]?.rank ?? Number.MAX_SAFE_INTEGER
    const bLast = b.points[b.points.length - 1]?.rank ?? Number.MAX_SAFE_INTEGER
    return aLast - bLast
  })
}

/** Distinct capture dates across every series, oldest first — the chart's x axis. */
export function captureDates(rows: { captured_for: string }[]): string[] {
  return [...new Set(rows.map((r) => r.captured_for))].sort((a, b) => a.localeCompare(b))
}
