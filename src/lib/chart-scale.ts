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

// --- the absolute half: squads, scored against targets rather than each other ---

/**
 * The midpoint of a squad's target scale.
 *
 * Numerically the same 50 as `MEDIAN`, and deliberately a separate name, because
 * it is a different claim. `MEDIAN` says "half the cohort is either side of this";
 * this says "halfway between the bad threshold and the good one", and nobody has
 * to be near it. Sharing one constant between the two is exactly how an absolute
 * score starts getting read as a relative one.
 */
export const TARGET_MIDPOINT = 50

/**
 * The domain for a score measured against absolute thresholds: the whole 0-100
 * run, always, whatever the data does.
 *
 * This is the deliberate opposite of `scoreDomain`, and it takes no arguments so
 * that it *cannot* be made to rescale. Squad scores are the one family on this
 * page where 0 and 100 are fixed thresholds rather than observed extremes, so
 * cropping to the data would throw away the only meaning the axis has — every
 * squad here clears most targets and sits between 93 and 100 on several
 * dimensions, and a fitted axis would spread that ceiling across the full plot
 * and manufacture a loser out of a strong org.
 */
export function absoluteDomain(): [number, number] {
  return [0, 100]
}

/** Where `v` sits inside a domain, as a fraction from 0 at `lo` to 1 at `hi`. */
export function fractionIn(v: number, [lo, hi]: [number, number]): number {
  return hi === lo ? 0 : (v - lo) / (hi - lo)
}

/**
 * The radius of a bubble whose **area** is proportional to `value`.
 *
 * Area, not radius. Mapping a count straight onto the radius squares it on the
 * way to the eye, so a squad of four would read four times the weight of a squad
 * of one rather than twice it — the single most common way a bubble chart
 * overstates its biggest subject. There is deliberately no minimum radius: a
 * floor would break the proportion for exactly the smallest bubbles, so a subject
 * too small to size is left off the plot and named instead.
 */
export function bubbleRadius(value: number, maxValue: number, maxRadius: number): number {
  if (!(value > 0) || !(maxValue > 0)) return 0
  return maxRadius * Math.sqrt(Math.min(value, maxValue) / maxValue)
}

/**
 * A number that was actually measured, or null.
 *
 * A missing sub-score means "not measured", and `null` coerces to 0 in arithmetic
 * far too quietly for a chart where 0 is the bad threshold. Everything that
 * reaches an axis goes through here first.
 */
export function measured(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Split subjects into the ones that can be placed on two axes and the ones that
 * cannot, without ever substituting a number for a missing one.
 *
 * A dimension with no data drops out of the composite and the remaining weights
 * are renormalised, so a subject can be scored overall and still have nothing to
 * place on one axis — DevExp has a genuine null quality score. Those are returned
 * as `absent` for the caller to name, because plotting them at 0 would put the
 * squad on the bad threshold of a dimension nobody measured.
 */
export function measuredPairs<T>(
  items: readonly T[],
  x: (item: T) => number | null | undefined,
  y: (item: T) => number | null | undefined,
): { placed: { item: T; x: number; y: number }[]; absent: T[] } {
  const placed: { item: T; x: number; y: number }[] = []
  const absent: T[] = []
  for (const item of items) {
    const vx = measured(x(item))
    const vy = measured(y(item))
    if (vx === null || vy === null) absent.push(item)
    else placed.push({ item, x: vx, y: vy })
  }
  return { placed, absent }
}
