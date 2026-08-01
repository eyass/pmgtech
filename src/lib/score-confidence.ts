/**
 * How a confidence flag becomes a mark on a chart, in one place.
 *
 * Every chart on `/rankings` used to derive its mark from `score_confidence ===
 * 'high'`, which collapses four distinct states into a boolean and draws three of
 * them identically. That was tolerable while three states existed and two of them
 * meant roughly the same thing. `0028_tenure_normalisation.sql` added a fourth that
 * does not:
 *
 *  - `thin` and `no_cohort` both mean *we do not know much about this person*.
 *  - `partial_window` means *we know what we know, and they were only here for part
 *    of the period*. They are excluded from the cohort median and still ranked
 *    against it. A hollow dot tells the reader "not much data on this person" when
 *    the truth is "this person was here one week and is being ranked against a
 *    median they did not help set", which is a different conversation entirely.
 *
 * So there are three marks, not two. The mapping is a `Record` over the union rather
 * than an if-chain on purpose: an if-chain that fell through was a real bug on
 * `/outliers`, where `partial_window` rendered as "no cohort" because it landed on
 * whichever branch the `else` happened to end on. A `Record<ScoreConfidence, …>`
 * cannot compile once a fifth state is added without someone naming its mark.
 *
 * Wording comes from `SCORE_CONFIDENCE_LABEL`, which is already the shared map; this
 * module adds the *shape* and nothing else, so the two can never drift.
 *
 * No React here for the usual reason — `node --test` strips TypeScript but not JSX.
 */

// Relative and extensioned: `node --test` runs this module directly.
import { SCORE_CONFIDENCE_LABEL, type ScoreConfidence } from './types/performance.ts'

/**
 * How the dot is drawn.
 *
 *  - `solid`  filled — nothing to caveat.
 *  - `hollow` outline only — the score rests on thin data or no cohort.
 *  - `half`   half filled, half outline — present for part of the window. The shape
 *             is the meaning: half of the period is behind the mark. It is
 *             distinguishable from both of the others in greyscale and on a
 *             printout, which colour alone would not be.
 */
export type ConfidenceMark = 'solid' | 'hollow' | 'half'

export const SCORE_CONFIDENCE_MARK: Record<ScoreConfidence, ConfidenceMark> = {
  high: 'solid',
  thin: 'hollow',
  no_cohort: 'hollow',
  partial_window: 'half',
}

/**
 * What each mark means, in the one sentence a legend has room for.
 *
 * `partial_window`'s sentence is the whole point of this change, so it says the
 * consequence rather than the cause: not "joined recently" but "ranked against a
 * median they are not part of".
 */
export const CONFIDENCE_MARK_MEANING: Record<ScoreConfidence, string> = {
  high: 'Solid — enough work, in a cohort with a median',
  thin: 'Thin data — placement is indicative',
  no_cohort: 'No cohort — fewer than three peers at this level',
  partial_window: 'Part period — ranked, but not in the cohort median they are ranked against',
}

/** Null confidence is treated as unknown, which is a caveat, not a clean score. */
export function confidenceMark(confidence: ScoreConfidence | null | undefined): ConfidenceMark {
  return confidence ? SCORE_CONFIDENCE_MARK[confidence] : 'hollow'
}

/** The boolean the charts used to compute inline. Kept so call sites read the same. */
export function isSolidMark(confidence: ScoreConfidence | null | undefined): boolean {
  return confidenceMark(confidence) === 'solid'
}

export type ConfidenceState = {
  confidence: ScoreConfidence
  /** From `SCORE_CONFIDENCE_LABEL` — "solid", "thin data", "no cohort", "part period". */
  label: string
  mark: ConfidenceMark
  meaning: string
  count: number
}

/** Declaration order is legend order: the clean state first, then the caveats. */
const STATE_ORDER: ScoreConfidence[] = ['high', 'thin', 'no_cohort', 'partial_window']

/**
 * Which confidence states actually occur in a set of rows, with their counts.
 *
 * A legend listing states nobody is in teaches the reader to ignore the legend, and
 * a legend missing a state that *is* on the chart is worse than none. Both problems
 * go away if the legend is computed from the rows it sits under — so this returns
 * only what is present, and the caller renders exactly what it gets back.
 */
export function confidenceStates(
  flags: (ScoreConfidence | null | undefined)[],
): ConfidenceState[] {
  const counts = new Map<ScoreConfidence, number>()
  for (const flag of flags) {
    if (!flag) continue
    counts.set(flag, (counts.get(flag) ?? 0) + 1)
  }
  const present = STATE_ORDER.filter((c) => (counts.get(c) ?? 0) > 0)

  // A legend whose only entry is "solid" distinguishes nothing — every mark on the
  // chart is the same mark, and the row is pure furniture. Any *other* single state
  // is kept, because "every score here rests on thin data" is a caveat the reader
  // needs whether or not there is something to contrast it with.
  if (present.length === 1 && present[0] === 'high') return []

  return present.map((confidence) => ({
    confidence,
    label: SCORE_CONFIDENCE_LABEL[confidence].label,
    mark: SCORE_CONFIDENCE_MARK[confidence],
    meaning: CONFIDENCE_MARK_MEANING[confidence],
    count: counts.get(confidence)!,
  }))
}
