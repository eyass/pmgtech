/**
 * The one place the axis-honesty rules live.
 *
 * Every chart on the Outliers page plots the same kind of number — a 0-100 score
 * whose 50 is a median rather than a midpoint — so they all need the same two
 * guards, and they need them to agree. Duplicating the rule per chart is how two
 * charts on one page end up implying different spreads for the same data.
 */

/** Cohort scores are built so 50 is the median. Nothing here may scale it away. */
export const MEDIAN = 50

/**
 * A padded domain that never zooms tighter than 40 points and always contains the
 * median, snapped outward to 5s.
 *
 * The floor is the important half. Fitting an axis to its data is what makes a
 * chart lie: a cohort whose scores span three points would otherwise fill the
 * plot exactly like one spanning sixty. One interquartile range of a cohort is
 * worth 15 points by construction, so 40 keeps a near-tie looking like a near-tie.
 */
export function scoreDomain(values: number[]): [number, number] {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length === 0) return [MEDIAN - 20, MEDIAN + 20]

  let lo = Math.min(...usable)
  let hi = Math.max(...usable)
  const pad = Math.max(2, (hi - lo) * 0.06)
  lo -= pad
  hi += pad

  // The median line has to be on the plot or the quadrants mean nothing.
  lo = Math.min(lo, MEDIAN - 4)
  hi = Math.max(hi, MEDIAN + 4)

  if (hi - lo < 40) {
    const centre = (hi + lo) / 2
    lo = centre - 20
    hi = centre + 20
  }

  return [Math.max(0, Math.floor(lo / 5) * 5), Math.min(100, Math.ceil(hi / 5) * 5)]
}

/** Every multiple of ten inside the domain. */
export function ticksIn([lo, hi]: [number, number]): number[] {
  const out: number[] = []
  for (let t = Math.ceil(lo / 10) * 10; t <= hi; t += 10) out.push(t)
  return out
}
