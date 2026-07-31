/**
 * Where a capture lands on a trend chart, in pixels.
 *
 * Split out of `score-history.ts` for the same reason `radar-geometry.ts` is split
 * out of the radar: the semantics ("is this difference real") and the arithmetic
 * ("where does the dot go") fail differently and are worth testing separately. And
 * both have to be `.ts` rather than `.tsx`, because `node --test
 * --experimental-strip-types` strips TypeScript but not JSX.
 *
 * The rule this file exists to enforce is the tie. Two subjects on the same rank are
 * not an edge case in this org — Alan Patekar and Mehmet Cetin both hold rank 6 on
 * 50.8 in the only capture there is — and drawn naively their lines are the same
 * line. One of them then has no mark to hover, no target to tab to, and nothing on
 * screen says two people are there. `rankTieOffsets` fans them apart by a fixed,
 * deterministic amount that is smaller than the gap between ranks, so the tie stays
 * legible *as* a tie while both lines stay reachable.
 */

// --- the rank axis ------------------------------------------------------------

/**
 * Vertical position of a rank, **inverted**: rank 1 sits at `top`.
 *
 * Everyone reads first place as up. A rank axis drawn the other way round is
 * technically a correct plot of an ascending integer and is misread by every reader,
 * which is the same trade `rank-slope.tsx` already took.
 *
 * A single-rank axis (`maxRank` of 1) puts the row on the top line rather than
 * dividing by zero.
 */
export function rankY(rank: number, maxRank: number, top: number, bottom: number): number {
  if (maxRank <= 1) return top
  const clamped = Math.min(Math.max(rank, 1), maxRank)
  return top + ((clamped - 1) / (maxRank - 1)) * (bottom - top)
}

/** Horizontal position of the `index`-th capture out of `count`. */
export function captureX(index: number, count: number, left: number, right: number): number {
  if (count <= 1) return right
  const clamped = Math.min(Math.max(index, 0), count - 1)
  return left + (clamped / (count - 1)) * (right - left)
}

// --- ties ----------------------------------------------------------------------

/**
 * How far each subject is nudged off its rank line so a tie stays countable.
 *
 * Deterministic and symmetrical: members of a tie are ordered by id, and the group
 * is centred on the rank it shares, so the pair straddles the true position rather
 * than one of them being demoted to make room. A permuted input gives an identical
 * answer, which matters because these charts re-render on every request and a tie
 * that swaps sides between renders reads as movement.
 *
 * `spread` is the distance between adjacent tied lines in the same units the caller
 * draws in — pass pixels. Keep it below half the distance between two ranks, or a
 * fanned tie will overlap the rank above; `rankTieOffsets` deliberately does not
 * clamp it for the caller, because silently shrinking a spread the caller chose
 * would produce marks closer together than the 24px hit targets they were sized for.
 *
 * Subjects with a null rank get no offset: they are not on the axis at all.
 */
export function rankTieOffsets(
  entries: readonly { id: string; rank: number | null }[],
  spread: number,
): Map<string, number> {
  const groups = new Map<number, string[]>()
  for (const entry of entries) {
    if (entry.rank === null) continue
    const bucket = groups.get(entry.rank)
    if (bucket) bucket.push(entry.id)
    else groups.set(entry.rank, [entry.id])
  }

  const offsets = new Map<string, number>()
  for (const ids of groups.values()) {
    const ordered = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const centre = (ordered.length - 1) / 2
    ordered.forEach((id, index) => {
      offsets.set(id, (index - centre) * spread)
    })
  }
  return offsets
}

/**
 * The tie offsets for every capture day at once, keyed `day|id`.
 *
 * A tie is a fact about one capture, not about a subject: two engineers can share
 * rank 6 in June and be three ranks apart in July, and the line has to fan out and
 * come back together. Computing the whole grid up front keeps that consistent
 * between the polyline, the marks and the hit targets, which have to agree exactly
 * or the target stops covering the line it belongs to.
 */
export function tieOffsetGrid(
  days: readonly string[],
  subjects: readonly { id: string; rankOn: (day: string) => number | null }[],
  spread: number,
): Map<string, number> {
  const grid = new Map<string, number>()
  for (const day of days) {
    const entries = subjects.map((s) => ({ id: s.id, rank: s.rankOn(day) }))
    for (const [id, offset] of rankTieOffsets(entries, spread)) grid.set(`${day}|${id}`, offset)
  }
  return grid
}

// --- sparklines -----------------------------------------------------------------

/**
 * Vertical position of a score inside a domain, top-down.
 *
 * Takes the domain rather than deriving it, so the caller decides which of the two
 * axis rules in `chart-scale.ts` applies: `scoreDomain` with its 40-point floor for
 * engineers, `absoluteDomain` for squads, which must never rescale to its data. A
 * sparkline that picks its own domain is exactly the chart that makes a
 * three-point wobble look like a collapse.
 */
export function scoreY(value: number, domain: [number, number], top: number, bottom: number): number {
  const [lo, hi] = domain
  if (hi === lo) return (top + bottom) / 2
  const clamped = Math.min(Math.max(value, lo), hi)
  return bottom - ((clamped - lo) / (hi - lo)) * (bottom - top)
}

/** `x,y x,y …` for an SVG `points` attribute. */
export function polylinePoints(points: readonly { x: number; y: number }[]): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ')
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}
