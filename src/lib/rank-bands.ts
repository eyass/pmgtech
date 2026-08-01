/**
 * The two pieces of geometry the ranking charts share, kept out of the components
 * so they can be tested. `node --test` strips TypeScript but not JSX, so anything
 * a test needs to import has to live in a `.ts` file — the same reason
 * `chart-scale.ts` exists next to the charts rather than inside them.
 *
 * Nothing here invents a threshold. `MATERIAL_SCORE_GAP` is the score-space
 * restatement of a rule the database already applies; see its comment.
 */

/**
 * How far apart two composite scores have to be before the difference is worth
 * saying out loud: **one interquartile range of the cohort, which is 15 points.**
 *
 * This is not a new threshold, it is the existing one converted into the units the
 * chart draws in. `score_vs_cohort` in `0021_outliers.sql` is built so that ±1 IQR
 * of an engineer's own seniority cohort is ±15 points either side of 50, and
 * `0018_material_performance_bands.sql` refuses to call a band 'above' or 'below'
 * until the underlying metric clears an absolute materiality gate, precisely so
 * that a rank computed on noise cannot start a conversation. The composite score
 * inherited the ranking but not the gate: `rank_in_org` is a dense ordering over
 * numbers that are frequently a fraction of an IQR apart. 15 points is the gate
 * the rest of the app already uses, applied to the number the ranking is made of.
 */
export const MATERIAL_SCORE_GAP = 15

/** Two scores are materially apart only once they clear a full interquartile range. */
export function materiallyApart(a: number, b: number): boolean {
  return Math.abs(a - b) >= MATERIAL_SCORE_GAP
}

export type TieBand = {
  /** 0 is the highest-scoring band. */
  index: number
  /** Highest score in the band — the leader every member is measured against. */
  top: number
  /** Lowest score in the band. */
  bottom: number
  ids: string[]
}

/**
 * Partition scored rows into groups that cannot be told apart.
 *
 * Greedy from the top: the highest unbanded score opens a band, and every score
 * below it joins while it sits **within** one interquartile range of that leader.
 * Because the input is sorted descending, the leader is also the band's maximum,
 * so the rule guarantees the property that matters — *no two members of a band are
 * materially apart from each other*, not merely from their neighbour. Chaining on
 * consecutive gaps instead would have let a 23-point spread accumulate through
 * 3-point steps and called all of it a tie.
 *
 * The cost is a threshold's usual one: two engineers either side of a band edge can
 * be closer than two inside a band. So the bands are deliberately a *lower bound*
 * on how much of the ranking is noise — where one is drawn the tie is certain,
 * and a split is not a claim that those two are different. Rows with no score are
 * dropped rather than banded, matching how a null dimension drops out of the
 * composite instead of counting as zero.
 */
export function tieBands(rows: { id: string; score: number | null }[]): TieBand[] {
  const scored = rows
    .filter((r): r is { id: string; score: number } => r.score !== null && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const bands: TieBand[] = []
  for (const row of scored) {
    const open = bands[bands.length - 1]
    if (open && !materiallyApart(open.top, row.score)) {
      open.ids.push(row.id)
      open.bottom = Math.min(open.bottom, row.score)
      continue
    }
    bands.push({ index: bands.length, top: row.score, bottom: row.score, ids: [row.id] })
  }
  return bands
}

export type TieSummary = {
  /** Rows with a score. Unscored rows are not part of a ranking at all. */
  scored: number
  /** How many of them share a band with at least one other engineer. */
  tied: number
  /** How many bands the scored rows fall into. */
  bands: number
  /**
   * The finding as one clause, or null when there is no ranking to describe.
   * Sentence case and no full stop, so it can sit in a header line beside
   * "14 engineers and 4 squads" or under a chart as a legend.
   */
  sentence: string | null
}

/**
 * How much of a ranking is real, counted rather than asserted.
 *
 * This is the single most important sentence the page can say, and it was living in
 * an 11px legend under the first chart. Lifting it into the header meant it had to
 * be computable by a server component, which meant it had to live in a `.ts` lib —
 * a value exported from a `'use client'` module is a client reference and the page
 * throws at request time. The chart's own legend now reads the same function, so the
 * header and the legend cannot disagree.
 *
 * The small-N branches are not defensive padding; each is a sentence that would
 * otherwise be false or absurd:
 *
 *  - **Nobody scored.** No sentence at all. "0 of 0" is not a finding.
 *  - **One engineer.** There is no ranking, so there is nothing to be noise. Saying
 *    "0 of 1 hold a rank number that is not a difference" implies the one rank
 *    number means something, which is the opposite of true.
 *  - **Nobody tied.** The positive claim, said positively. Falling through to
 *    "0 of 14 hold a rank number that is not a difference" is technically right and
 *    reads as a hedge.
 *  - **Everybody tied.** "14 of 14" is arithmetic nobody should have to do; say the
 *    thing it means.
 */
export function tieSummary(rows: { id: string; score: number | null }[]): TieSummary {
  const bands = tieBands(rows)
  const scored = bands.reduce((n, b) => n + b.ids.length, 0)
  const tied = bands.filter((b) => b.ids.length > 1).reduce((n, b) => n + b.ids.length, 0)

  const sentence =
    scored === 0
      ? null
      : scored === 1
        ? 'one scored engineer, so there is no ranking to separate'
        : tied === 0
          ? `every rank number here clears a full interquartile range`
          : tied === scored
            ? `no rank number here is a difference — all ${scored} sit inside a tie band`
            : `${tied} of ${scored} hold a rank number that is not a difference`

  return { scored, tied, bands: bands.length, sentence }
}

/**
 * Which vertical lane each dot goes in so a row of them stays countable.
 *
 * Deterministic, never random: dots are laid out in ascending position (ties broken
 * by id, so a permuted input gives an identical answer), and each takes the lane
 * closest to the centre line that has nothing within `minGap` of it. Lanes are
 * tried 0, +1, −1, +2, −2 …, which keeps the swarm symmetrical about its row and
 * puts sparse regions flat on the line where they read as a strip plot.
 *
 * `positions` and `minGap` are both in the same units — pass rendered pixels, so
 * the collision test is about what actually overlaps rather than about score
 * distance on whatever axis happens to be in force.
 */
export function beeswarmLanes(
  points: { id: string; position: number }[],
  minGap: number,
): Map<string, number> {
  const ordered = [...points].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  const lanes = new Map<string, number>()
  const occupied = new Map<number, number[]>()

  for (const point of ordered) {
    for (let step = 0; ; step += 1) {
      // 0, +1, -1, +2, -2 … — centre first, then alternating out.
      const lane = step === 0 ? 0 : (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2)
      const taken = occupied.get(lane) ?? []
      if (taken.every((p) => Math.abs(p - point.position) >= minGap)) {
        taken.push(point.position)
        occupied.set(lane, taken)
        lanes.set(point.id, lane)
        break
      }
    }
  }
  return lanes
}

/**
 * Where a rank inside a cohort sits on a shared 1..`span` scale.
 *
 * Ranks at level are not comparable across levels as raw numbers: last of five mids
 * is a worse placing than sixth of nine seniors, but 5 draws above 6. Stretching
 * each cohort's rank across the full column instead makes "top of my level" the top
 * of the axis and "bottom of my level" the bottom, whatever the cohort's size — the
 * only reading of a level rank that survives being drawn next to another level's.
 *
 * Null when there is nobody to be ranked against; one person at a level is #1 of 1,
 * which is not a placing and must not be drawn as the top of the column.
 */
export function levelSlot(rankAtLevel: number, peersAtLevel: number, span: number): number | null {
  if (peersAtLevel < 2 || span < 1) return null
  const clamped = Math.min(Math.max(rankAtLevel, 1), peersAtLevel)
  return 1 + ((clamped - 1) * (span - 1)) / (peersAtLevel - 1)
}
