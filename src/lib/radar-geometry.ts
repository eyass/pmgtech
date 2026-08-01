/**
 * The radar's maths, its scale and its honesty rules, with no React in it.
 *
 * Same reason `chart-scale.ts` exists: the rules that keep a chart honest are
 * worth testing, and a rule buried in a component is a rule nobody can test.
 *
 * **Import the constants and functions from here, not from the components.** The
 * three radar components are `'use client'` modules, and every export of a
 * `'use client'` module becomes a client reference — a server component that
 * imports `medianProfile` from `@/components/radar` gets a proxy and throws
 * "Attempted to call medianProfile() from the server" at request time. So the
 * components re-export the *types* (erased at compile time, safe either side) and
 * nothing else. Server pages compose from this module; the components render it.
 *
 * The rules themselves — fixed scale, fixed axis order, area is not an ordering —
 * are restated in `radar.tsx`'s file comment, which is where a reader looking at a
 * chart will go.
 */

// Relative and extensioned, not `@/lib/chart-scale`: `node --test` runs these
// modules directly and does not resolve the bundler's path alias.
import { MEDIAN } from './chart-scale.ts'
import { SCORE_CONFIDENCE_LABEL, type ScoreConfidence } from './types/performance.ts'

// --- the contract -----------------------------------------------------------

/**
 * The axis order: throughput → flow → quality → collaboration, clockwise from
 * the top. **This order is part of the contract, not a detail.** The same four
 * numbers in a different order draw a different outline and enclose a different
 * area, so a reader who has learned one order is misled by another. There is one
 * definition and callers cannot reorder it.
 *
 * The four axes sit exactly on the compass points, which keeps the geometry in
 * exact integers rather than in floating-point cosines and makes a rendered shape
 * reproducible from its four numbers.
 */
export const RADAR_AXES = [
  { key: 'throughput', label: 'Throughput', short: 'T', unit: [0, -1] },
  { key: 'flow', label: 'Flow', short: 'F', unit: [1, 0] },
  { key: 'quality', label: 'Quality', short: 'Q', unit: [0, 1] },
  { key: 'collaboration', label: 'Collaboration', short: 'C', unit: [-1, 0] },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  short: string
  unit: readonly [number, number]
}>

export type RadarAxisKey = (typeof RADAR_AXES)[number]['key']

/** The four sub-scores. `null` means "not measured", never zero. */
export type RadarValues = Record<RadarAxisKey, number | null>

/**
 * The radial scale, fixed. Never fitted to the data and never derived from it:
 * small multiples are only comparable when every chart shares one scale, and a
 * fitted radius would make a cohort spanning three points fill the ring exactly
 * like one spanning sixty. No code path changes these.
 */
export const RADAR_MIN = 0
export const RADAR_MAX = 100

/**
 * The reference ring. 50 *is* the cohort median by construction, so this is the
 * same `MEDIAN` the scatter and the strip plot draw their crosshair at — imported
 * rather than written as 50, because two charts on one page disagreeing about
 * where the median is would be the worst version of this bug.
 */
export const RADAR_REFERENCE = MEDIAN

export type RadarSubject = {
  id: string
  name: string
  /** Level, squad, headcount — whatever belongs under the name. */
  meta?: string | null
  values: RadarValues
  /** The composite. Printed as a number, because area is not an ordering. */
  score: number | null
  /**
   * False for thin data or no cohort. Drawn hollow — never in another colour and
   * never in colour alone, so the caveat survives greyscale and a printout.
   */
  solid: boolean
  /**
   * Which caveat it is, when there is one. A radar is a polygon rather than a dot,
   * so there is no third shape to give `partial_window` here — but the *wording*
   * must still be right, and "Thin data:" in front of a part-period engineer is
   * simply false. Optional so squads, which never carry the fourth state, can be
   * built without it.
   */
  confidence?: ScoreConfidence | null
  /** Why confidence is thin, in the app's own words. */
  note?: string | null
}

/**
 * What kind of subject is on the chart, which changes what 50 means.
 *
 * Engineers are scored against their own seniority cohort, so 50 is that cohort's
 * median. Squads are scored against absolute targets, so 50 is halfway between the
 * bad and the good threshold and is not a median of anything. The reference ring is
 * drawn at 50 either way; calling it "the cohort median" on a squad chart would be
 * false, so the wording follows the kind.
 */
export type RadarKind = 'engineers' | 'squads'

export const REFERENCE_MEANING: Record<RadarKind, string> = {
  engineers: 'the cohort median',
  squads: 'halfway between the bad and good targets',
}

/** A shape to sit a subject against: the median of their own level, usually. */
export type RadarReference = {
  label: string
  values: RadarValues
  /** e.g. "median of 9 Senior Engineers". */
  detail?: string | null
}

// --- geometry ---------------------------------------------------------------

export type RadarGeometry = { cx: number; cy: number; radius: number }

/**
 * Where one value lands on one axis.
 *
 * Clamped to 0-100 rather than rescaled to fit, because a value outside the scale
 * would otherwise silently redraw every other chart sharing it.
 */
export function radarPoint(
  axis: RadarAxisKey,
  value: number,
  { cx, cy, radius }: RadarGeometry,
): { x: number; y: number } {
  const spec = RADAR_AXES.find((a) => a.key === axis)
  if (!spec) throw new Error(`Unknown radar axis: ${axis}`)
  const clamped = Math.min(RADAR_MAX, Math.max(RADAR_MIN, value))
  const r = (clamped / RADAR_MAX) * radius
  return { x: cx + spec.unit[0] * r, y: cy + spec.unit[1] * r }
}

/** The closed polygon for one constant value on every axis — a grid ring. */
export function radarRing(value: number, geometry: RadarGeometry): string {
  return RADAR_AXES.map((axis) => {
    const { x, y } = radarPoint(axis.key, value, geometry)
    return `${round(x)},${round(y)}`
  }).join(' ')
}

export type RadarVertex = {
  axis: RadarAxisKey
  label: string
  value: number
  x: number
  y: number
}

/**
 * The subject's own outline.
 *
 * An axis with no value is omitted from the outline rather than plotted at zero,
 * and returned in `missing` so the caller can label it — DevExp has no quality
 * score in this org's 90-day window, and drawing that as a zero would invent a
 * finding. The outline then closes over the axes that were measured, which makes
 * the shape smaller: exactly why area must never be read as an ordering.
 *
 * Below two measured axes there is no polygon at all and `points` is empty. One
 * dot on one spoke is not a shape.
 */
export function radarShape(
  values: RadarValues,
  geometry: RadarGeometry,
): { vertices: RadarVertex[]; missing: RadarAxisKey[]; points: string } {
  const vertices: RadarVertex[] = []
  const missing: RadarAxisKey[] = []
  for (const axis of RADAR_AXES) {
    const value = values[axis.key]
    if (!isMeasured(value)) {
      missing.push(axis.key)
      continue
    }
    const { x, y } = radarPoint(axis.key, value, geometry)
    vertices.push({ axis: axis.key, label: axis.label, value, x, y })
  }
  const points =
    vertices.length >= 2 ? vertices.map((v) => `${round(v.x)},${round(v.y)}`).join(' ') : ''
  return { vertices, missing, points }
}

/**
 * How far from balanced a profile is: the largest distance any measured axis sits
 * from that profile's own mean, in score points.
 *
 * This is what "spiky" means, and it is deliberately *not* area — it is the
 * spread of the four numbers, which is what a reader scanning small multiples is
 * actually looking for. Fewer than two measured axes has no spread.
 */
export function radarSpread(values: RadarValues): number | null {
  const measured = RADAR_AXES.map((a) => values[a.key]).filter(isMeasured)
  if (measured.length < 2) return null
  const mean = measured.reduce((sum, v) => sum + v, 0) / measured.length
  return Math.max(...measured.map((v) => Math.abs(v - mean)))
}

/**
 * The median shape of a group, axis by axis.
 *
 * Per-axis rather than "the median person's shape", because there is no such
 * person: the engineer in the middle of throughput is rarely the one in the
 * middle of quality. An axis nobody in the group has data for stays null.
 */
export function medianProfile(subjects: Array<{ values: RadarValues }>): RadarValues {
  const out = {} as RadarValues
  for (const axis of RADAR_AXES) {
    const values = subjects
      .map((s) => s.values[axis.key])
      .filter(isMeasured)
      .sort((a, b) => a - b)
    if (values.length === 0) {
      out[axis.key] = null
      continue
    }
    const mid = Math.floor(values.length / 2)
    out[axis.key] = values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2
  }
  return out
}

/** All four values as a sentence, for `aria-label` and hover titles. */
export function describeProfile(subject: RadarSubject): string {
  const parts = RADAR_AXES.map((axis) => {
    const value = subject.values[axis.key]
    return `${axis.label.toLowerCase()} ${isMeasured(value) ? value.toFixed(1) : 'no data'}`
  })
  const composite =
    subject.score === null ? 'no composite score' : `composite ${subject.score.toFixed(1)} of 100`
  // The caveat is named from the shared label map rather than assumed to be thin
  // data: `no_cohort` and `partial_window` are also not-solid and are not that.
  const caveatLabel = subject.confidence
    ? SCORE_CONFIDENCE_LABEL[subject.confidence].label
    : 'Thin data'
  const caveat = subject.solid
    ? ''
    : ` ${capitaliseFirst(caveatLabel)}: ${subject.note ?? 'placement is indicative'}.`
  return `${subject.name}. ${parts.join(', ')}. ${composite}.${caveat}`
}

function capitaliseFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

// --- orders for the small multiples -----------------------------------------

/**
 * Named orders for `RadarGrid`, kept here so a server page can validate a URL
 * parameter against them before handing the key to the component.
 */
export type RadarSortKey = 'score' | 'spread' | 'balance' | 'name'

export const RADAR_SORT_LABELS: Record<RadarSortKey, string> = {
  score: 'Composite score, highest first',
  spread: 'Spikiest first — the specialists',
  balance: 'Most balanced first — the generalists',
  name: 'Name, A to Z',
}

/**
 * The comparators.
 *
 * "Spikiest" is `radarSpread` — the largest distance any dimension sits from the
 * subject's own mean — and never the area of the polygon. A subject with fewer
 * than two measured dimensions has no spread and sorts last in both spread orders
 * rather than being flattered as perfectly balanced.
 */
export const RADAR_SORTS: Record<RadarSortKey, (a: RadarSubject, b: RadarSubject) => number> = {
  score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name),
  spread: (a, b) => spreadOrLast(b) - spreadOrLast(a) || a.name.localeCompare(b.name),
  balance: (a, b) => {
    const sa = radarSpread(a.values)
    const sb = radarSpread(b.values)
    if (sa === null && sb === null) return a.name.localeCompare(b.name)
    if (sa === null) return 1
    if (sb === null) return -1
    return sa - sb || a.name.localeCompare(b.name)
  },
  name: (a, b) => a.name.localeCompare(b.name),
}

function spreadOrLast(subject: RadarSubject): number {
  return radarSpread(subject.values) ?? -1
}

// --- how many shapes a radar can honestly carry -----------------------------

/**
 * Two. Not a style preference: overlaid polygons occlude each other, and from
 * three onwards a reader cannot tell which outline owns which vertex, so the
 * chart stops carrying the values it appears to show. Three squads on one radar
 * is a picture of nothing.
 *
 * The cohort-median reference shape does not count against this. It is drawn as a
 * filled backdrop with no vertices of its own, so it cannot be mistaken for a
 * third subject.
 */
export const MAX_OVERLAID_SHAPES = 2

export type OverlayCheck =
  | { ok: true; count: 2 }
  | { ok: false; reason: 'too-many' | 'too-few'; message: string }

/** Whether a set of subjects can be overlaid, and what to say when it cannot. */
export function overlayCheck(count: number): OverlayCheck {
  if (count > MAX_OVERLAID_SHAPES) {
    return {
      ok: false,
      reason: 'too-many',
      message:
        `${count} shapes on one radar cannot be read: overlaid polygons hide each ` +
        `other's vertices, so from three onwards no value on the chart is legible. ` +
        `Compare two at a time, or use the small multiples to scan more than two.`,
    }
  }
  if (count < MAX_OVERLAID_SHAPES) {
    return {
      ok: false,
      reason: 'too-few',
      message:
        count === 0
          ? 'Pick two engineers or two squads to compare.'
          : 'Pick a second subject to compare against.',
    }
  }
  return { ok: true, count: 2 }
}

// --- materiality ------------------------------------------------------------

/**
 * The gap, in score points, below which two subjects are the same on a dimension.
 *
 * **One cohort interquartile range, which is 15 points by construction.** This is
 * not a new threshold — it is the app's existing materiality logic expressed in
 * the units the sub-scores are already in:
 *
 *  - `score_vs_cohort` in `0021_outliers.sql` builds every dimension so that 50 is
 *    the cohort median and ±1 interquartile range is ±15 points.
 *  - `0018_material_performance_bands.sql` will only call a dimension `above` at
 *    or beyond the cohort's third quartile, and `below` at or within its first.
 *    So the smallest distance at which this app is already willing to say two
 *    engineers are in different places is Q3 − Q1 — one interquartile range,
 *    15 points. Anything less and 0018 is content to call both of them `typical`,
 *    and the Gap column on `/outliers` reads *even* for exactly that reason.
 *
 * Which makes the rule: **a dimension is material only when the two subjects are
 * at least `MATERIAL_GAP_POINTS` apart.** A two-point difference reads "same",
 * because it is the same score. This view is what gets opened before a calibration
 * conversation, and a chart that turns two points into a win manufactures the
 * conversation 0018 was written to prevent.
 *
 * Two suppressions come before the arithmetic, in 0018's own order —
 * "insufficient" and "typical" are different statements, and cannot see must never
 * be collapsed into nothing there:
 *
 *  1. A dimension either subject has no data for is **not readable**, not equal.
 *  2. A subject whose score confidence is not `high` — thin work in the window, or
 *     a cohort too small to have a median — makes every gap **not readable**. 0018
 *     suppresses a band outright on the same two conditions, and a gap between one
 *     solid score and one indicative score is not a gap that can be defended.
 *
 * Squad scores are built against absolute targets rather than a cohort, so 15
 * points there is not an interquartile range. The same gate is applied anyway and
 * on purpose: a compare view whose threshold changes with the kind of subject is
 * worse than one slightly conservative number, and `/outliers` already tells
 * readers that a two-point gap between squads is not a story.
 */
export const MATERIAL_GAP_POINTS = 15

export type GapVerdict = 'material' | 'same' | 'unreadable'

export type ScoreGap = {
  a: number | null
  b: number | null
  /** Absolute difference when both sides have a number — shown even when unreadable. */
  gap: number | null
  verdict: GapVerdict
  /** Which side is ahead. Only ever set when the verdict is `material`. */
  leader: 'a' | 'b' | null
  /** Plain-language reason, for the readout beside the row. */
  reason: string
}

export type GapSide = { name: string; value: number | null; solid: boolean }

/**
 * The rule, in one place. Applied identically to the four dimensions and to the
 * composite, because a view that gated the parts and not the total would let a
 * reader assemble a win the parts refuse to support.
 */
export function scoreGap(a: GapSide, b: GapSide): ScoreGap {
  const av = a.value
  const bv = b.value
  const base = { a: isMeasured(av) ? av : null, b: isMeasured(bv) ? bv : null }

  // 1. Cannot see. Distinct from "nothing there", and stated first — 0018's order.
  if (!isMeasured(av) || !isMeasured(bv)) {
    const both = !isMeasured(av) && !isMeasured(bv)
    return {
      ...base,
      gap: null,
      verdict: 'unreadable',
      leader: null,
      reason: both
        ? 'Neither has a score here'
        : `${!isMeasured(av) ? a.name : b.name} has no score here`,
    }
  }

  const gap = Math.abs(av - bv)

  // 2. Can see, but not well enough to defend a gap.
  if (!a.solid || !b.solid) {
    const both = !a.solid && !b.solid
    return {
      ...base,
      gap,
      verdict: 'unreadable',
      leader: null,
      reason: both
        ? 'Both scores rest on thin data or no cohort, so the gap is not readable'
        : `${!a.solid ? a.name : b.name}'s score rests on thin data or no cohort, so the gap is not readable`,
    }
  }

  // 3. Can see, and there is nothing there.
  if (gap < MATERIAL_GAP_POINTS) {
    return {
      ...base,
      gap,
      verdict: 'same',
      leader: null,
      reason: `${gap.toFixed(1)} points apart — inside one interquartile range, so the same score`,
    }
  }

  const leader = av > bv ? 'a' : 'b'
  return {
    ...base,
    gap,
    verdict: 'material',
    leader,
    // The leader is named in the reason rather than only beside the mark: a long
    // name overflowed the chart's own verdict column, and the sentence is where a
    // reader looks for the direction anyway.
    reason: `${gap.toFixed(1)} points apart — a full interquartile range or more, so a real difference, ${
      leader === 'a' ? a.name : b.name
    } ahead`,
  }
}

export type GapTally = { material: number; same: number; unreadable: number }

/**
 * How many dimensions landed in each verdict.
 *
 * Counted rather than inferred, because the difference between "we looked and found
 * nothing" and "we could not look" is the whole point of the `unreadable` verdict,
 * and a headline that reports the first when the truth is the second is the exact
 * failure this view exists to prevent.
 */
export function gapTally(gaps: ScoreGap[]): GapTally {
  return {
    material: gaps.filter((g) => g.verdict === 'material').length,
    same: gaps.filter((g) => g.verdict === 'same').length,
    unreadable: gaps.filter((g) => g.verdict === 'unreadable').length,
  }
}

export type DimensionGap = ScoreGap & { axis: RadarAxisKey; label: string }

/** Compare two subjects on one dimension. See `MATERIAL_GAP_POINTS` for the rule. */
export function dimensionGap(axis: RadarAxisKey, a: RadarSubject, b: RadarSubject): DimensionGap {
  const spec = RADAR_AXES.find((x) => x.key === axis)
  if (!spec) throw new Error(`Unknown radar axis: ${axis}`)
  return {
    axis,
    label: spec.label,
    ...scoreGap(
      { name: a.name, value: a.values[axis], solid: a.solid },
      { name: b.name, value: b.values[axis], solid: b.solid },
    ),
  }
}

/** Every dimension compared, in the fixed axis order. */
export function compareProfiles(a: RadarSubject, b: RadarSubject): DimensionGap[] {
  return RADAR_AXES.map((axis) => dimensionGap(axis.key, a, b))
}

/** The composites compared, under the same rule as the dimensions. */
export function compositeGap(a: RadarSubject, b: RadarSubject): ScoreGap {
  return scoreGap(
    { name: a.name, value: a.score, solid: a.solid },
    { name: b.name, value: b.score, solid: b.solid },
  )
}

// --- internals --------------------------------------------------------------

function isMeasured(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
