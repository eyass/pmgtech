/**
 * Which dimension produced a placing, and how much of it.
 *
 * Every chart on `/rankings` prints a composite and a rank, and neither says what
 * made them. That gap is not cosmetic. Raw engineer activity in this org varies by
 * two to four and a half times, and the composite compresses all of it into a
 * fourteen-point band in which almost nobody is materially apart from anybody —
 * the tie bands on the opening chart are the statement of that. So the page leads
 * with the number that *cannot* separate people and never surfaces the four that
 * can. This module is the four.
 *
 * No React and no JSX, for the usual reason: `node --test` strips TypeScript but
 * not JSX, so a rule that lives inside a component is a rule nobody can test. Same
 * contract as `rank-bands.ts` and `radar-geometry.ts` next to it.
 *
 * ## The decomposition is exact, not an estimate
 *
 * `0021_outliers.sql` builds the composite as an equally weighted mean over the
 * dimensions that have data, renormalising when one is missing:
 *
 *     composite = sum(25 * d) / sum(25)   over non-null d
 *               = mean(d)                 over non-null d
 *
 * Subtract 50 from both sides and the mean distributes:
 *
 *     composite - 50 = mean(d - 50) = sum((d - 50) / n)
 *
 * So each dimension's *contribution* to the composite's distance from the cohort
 * median is exactly `(d - 50) / n`, and those contributions sum to the distance
 * with nothing left over. There is no model here and no fitting — it is the
 * identity the SQL already computes, read backwards. That matters because an
 * attribution that only approximately adds up invites the reader to believe a
 * residual is a finding.
 *
 * ## A null dimension is withheld, not weak
 *
 * The SQL drops null terms and renormalises precisely so a missing input never
 * reads as a zero, and this must not undo that. A null dimension is excluded from
 * `n`, excluded from the terms, and reported separately as withheld. It can never
 * be named a driver and never counts against anybody.
 *
 * ## Why the gate stays at one interquartile range
 *
 * `MATERIAL_SCORE_GAP` is 15 points, and 15 points is one interquartile range of a
 * seniority cohort by construction — `score_vs_cohort` maps ±1 IQR to ±15 around
 * 50. The tie bands use it as a *between two people* gap. Here it is being used for
 * a different claim, *this dimension is far from the cohort median*, and the two
 * are not automatically the same number. Three ways of arriving at one:
 *
 *  - **The quartile reading (≈7.5) is too weak.** For any roughly symmetric cohort
 *    Q3 sits about half an IQR above the median, so ±7.5 points is the edge of the
 *    middle half. A quarter of every cohort clears that by definition, so it cannot
 *    be the threshold for calling something the thing that *distinguishes* someone.
 *  - **The statistical translation (≈10.6) is the wrong worry.** A difference
 *    between two individually noisy values carries √2 the noise of one value against
 *    a cohort statistic, which would argue for 15/√2. But the binding constraint
 *    here is not sampling noise, it is dilution — see the next point — and that
 *    pushes the other way, harder.
 *  - **Dilution is the binding constraint, and it argues for 15 or more.** A
 *    dimension `k` points from 50 moves the composite only `k / n` points. With all
 *    four dimensions present, a dimension a full IQR from the median shifts the
 *    composite 3.75 points — a quarter of the gate the same page uses to decide
 *    whether a composite difference is real at all. Below 15 the dimension is moving
 *    the composite by under 2.7 points, and calling that "the dimension that produced
 *    this placing" would be attributing a placing to an amount of movement the page
 *    elsewhere refuses to read. 15 is therefore the *loosest* defensible gate, not a
 *    conservative one.
 *
 * A corollary worth stating because it is a real finding rather than a caveat: the
 * maximum possible distance from 50 is 50 points, so a single dimension can move
 * the composite at most 12.5 points with all four present. **No one dimension can
 * ever move a composite by a material amount on its own.** That is why the gate has
 * to be "materially distant on its own axis" rather than "materially moved the
 * composite" — the latter is unsatisfiable and would name a driver for nobody, ever.
 *
 * Keeping the number at 15 has a second benefit that is not an accident: the page
 * says "fifteen points, one interquartile range" once, in the tie-band rule drawn
 * to scale at the top of the first chart, and every other claim on the page inherits
 * it. A driver panel gated at 10.6 sitting on the same rows as a band gated at 15
 * would be two thresholds a reader has to hold at once, and the first thing they
 * would notice is the contradiction rather than the finding.
 */

// Relative and extensioned: `node --test` runs these modules directly and does not
// resolve the bundler's `@/` alias.
import { MEDIAN } from './chart-scale.ts'
import { MATERIAL_SCORE_GAP } from './rank-bands.ts'
import { RADAR_AXES, type RadarAxisKey, type RadarValues } from './radar-geometry.ts'

/**
 * How far from 50 a dimension has to be before it is named as a driver.
 *
 * Deliberately the same constant the tie bands use rather than a second one; the
 * reasoning for that, and for the two smaller numbers rejected, is in the module
 * comment above. Re-exported under its own name so the call sites read as what
 * they mean and so a future change to one claim cannot silently change the other.
 */
export const MATERIAL_DIMENSION_DISTANCE = MATERIAL_SCORE_GAP

/**
 * Below this much composite distance from 50, a percentage share is not reported.
 *
 * The composite is published to one decimal place. Inside a point of the median the
 * denominator of `contribution / distance` is within rounding of zero, so the
 * percentage swings wildly on a difference the app cannot even print. The signed
 * contribution in composite points is still exact and still reported — only the
 * percentage is withheld, which is the right thing to drop because it is the one
 * that manufactures precision.
 */
export const SHARE_FLOOR = 1

export type DriverTerm = {
  dimension: RadarAxisKey
  /** "Flow" — the same label the radar axes use, so the page never renames a thing. */
  label: string
  /** The 0-100 sub-score itself. */
  score: number
  /** `score - 50`. Signed: positive is above the cohort median. */
  deviation: number
  /**
   * Signed composite points this dimension puts into the composite's distance from
   * 50, which is `deviation / n`. These sum exactly to `distance`.
   */
  contribution: number
  /**
   * `contribution / distance` — the fraction of the person's distance from the
   * median that this dimension accounts for. Negative when the dimension pulls
   * against the direction the composite ended up in, and above 1 when it more than
   * accounts for the distance and something else pulls back. Null inside
   * `SHARE_FLOOR` of the median.
   */
  share: number | null
  /** Whether `|deviation|` clears `MATERIAL_DIMENSION_DISTANCE`. */
  material: boolean
}

export type WithheldDimension = { dimension: RadarAxisKey; label: string }

export type DriverVerdict =
  /** No dimension had any data, so there is no composite and nothing to attribute. */
  | 'unscored'
  /** Scored, but no dimension is materially distant from the median. The common case. */
  | 'even'
  /** At least one dimension clears the gate. */
  | 'driven'

export type ScoreDrivers = {
  /** Measured dimensions, furthest from 50 first; ties keep the fixed axis order. */
  terms: DriverTerm[]
  /** Dimensions with no data behind them. Withheld, never weak, never a driver. */
  withheld: WithheldDimension[]
  /** The renormalised mean of the measured dimensions. Null when none are measured. */
  composite: number | null
  /** `composite - 50`. Null when there is no composite. */
  distance: number | null
  verdict: DriverVerdict
  /** The furthest-from-median dimension, but only when it clears the gate. */
  driver: DriverTerm | null
  /** Any further dimensions that also clear it, in the same order. */
  alsoMaterial: DriverTerm[]
  /**
   * Two or three words for a chart row: "flow +48". Null when nothing clears the
   * gate — the caller draws its own placeholder rather than being handed a dash,
   * so an em dash never ends up inside an `aria-label` as if it were a word.
   */
  headline: string | null
  /** The whole finding as one sentence, for a readout or an `aria-label`. */
  sentence: string
}

const LABEL: Record<RadarAxisKey, string> = Object.fromEntries(
  RADAR_AXES.map((a) => [a.key, a.label]),
) as Record<RadarAxisKey, string>

/** Axis order is a contract elsewhere, so it is also the tie-break here. */
const AXIS_ORDER: Record<RadarAxisKey, number> = Object.fromEntries(
  RADAR_AXES.map((a, i) => [a.key, i]),
) as Record<RadarAxisKey, number>

function isMeasured(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function signed(v: number, digits = 1): string {
  const rounded = Number(v.toFixed(digits))
  // -0 prints as "-0.0", which reads as a direction that is not there.
  const safe = rounded === 0 ? 0 : rounded
  return `${safe > 0 ? '+' : ''}${safe.toFixed(digits)}`
}

/**
 * Attribute one engineer's composite to the dimensions that made it.
 *
 * Takes the four sub-scores exactly as `engineer_outliers` returns them, nulls and
 * all. Everything else is derived; nothing is looked up and nothing is fitted.
 */
export function scoreDrivers(values: RadarValues): ScoreDrivers {
  const measured = RADAR_AXES.map((axis) => ({ axis: axis.key, value: values[axis.key] })).filter(
    (t): t is { axis: RadarAxisKey; value: number } => isMeasured(t.value),
  )

  const withheld: WithheldDimension[] = RADAR_AXES.filter(
    (axis) => !isMeasured(values[axis.key]),
  ).map((axis) => ({ dimension: axis.key, label: axis.label }))

  if (measured.length === 0) {
    return {
      terms: [],
      withheld,
      composite: null,
      distance: null,
      verdict: 'unscored',
      driver: null,
      alsoMaterial: [],
      headline: null,
      sentence: 'No dimension had any data behind it, so there is nothing to attribute.',
    }
  }

  const n = measured.length
  const composite = measured.reduce((sum, t) => sum + t.value, 0) / n
  const distance = composite - MEDIAN
  const shareIsMeaningful = Math.abs(distance) >= SHARE_FLOOR

  const terms: DriverTerm[] = measured
    .map((t) => {
      const deviation = t.value - MEDIAN
      const contribution = deviation / n
      return {
        dimension: t.axis,
        label: LABEL[t.axis],
        score: t.value,
        deviation,
        contribution,
        share: shareIsMeaningful ? contribution / distance : null,
        material: Math.abs(deviation) >= MATERIAL_DIMENSION_DISTANCE,
      }
    })
    .sort(
      (a, b) =>
        Math.abs(b.deviation) - Math.abs(a.deviation) ||
        AXIS_ORDER[a.dimension] - AXIS_ORDER[b.dimension],
    )

  const material = terms.filter((t) => t.material)
  const driver = material[0] ?? null
  const verdict: DriverVerdict = driver ? 'driven' : 'even'

  return {
    terms,
    withheld,
    composite,
    distance,
    verdict,
    driver,
    alsoMaterial: material.slice(1),
    headline: driver ? `${driver.label.toLowerCase()} ${signed(driver.deviation, 0)}` : null,
    sentence: describeDrivers({ terms, withheld, distance, driver, alsoMaterial: material.slice(1) }),
  }
}

/**
 * The finding as prose.
 *
 * Split out so the wording is tested directly rather than through a component, and
 * so the "nothing separates this person" branch is as deliberate as the other one.
 * It names the widest dimension in that branch *and says in the same clause that it
 * is not a difference*, because leaving it out invites the reader to go and find it
 * themselves on the beeswarm and draw the conclusion this sentence exists to refuse.
 */
function describeDrivers({
  terms,
  withheld,
  distance,
  driver,
  alsoMaterial,
}: {
  terms: DriverTerm[]
  withheld: WithheldDimension[]
  distance: number | null
  driver: DriverTerm | null
  alsoMaterial: DriverTerm[]
}): string {
  const parts: string[] = []

  if (driver && distance !== null) {
    const side = driver.deviation > 0 ? 'above' : 'below'
    const head =
      `${driver.label} is ${Math.abs(driver.deviation).toFixed(1)} ${side} the cohort median, ` +
      `worth ${signed(driver.contribution)}`
    const of = `of this composite's ${signed(distance)} from it`

    // Four endings, because a share outside 0-100% is a real and different fact and
    // printing "-857% of it" would be arithmetic pretending to be a sentence. The
    // out-of-range cases are not edge cases in this data: a dimension a full range
    // from the median moves the composite by a quarter of that, so whenever the
    // composite lands near 50 the shares are enormous or negative by construction.
    parts.push(
      driver.share === null
        ? `${head} of the composite — which sits within a point of the median, so there is no distance to share out.`
        : driver.share < 0
          ? `${head} — but this composite lands ${signed(distance)} from the median, so the other dimensions more than cancel it.`
          : driver.share > 1
            ? `${head} ${of} — more than the whole of it, with the rest pulling back.`
            : `${head} ${of}, ${Math.round(driver.share * 100)}% of the distance.`,
    )

    if (alsoMaterial.length > 0) {
      const rest = alsoMaterial.map(
        (t) =>
          `${t.label.toLowerCase()} ${Math.abs(t.deviation).toFixed(1)} ${t.deviation > 0 ? 'above' : 'below'}`,
      )
      parts.push(
        `${capitalise(sentenceList(rest, 'and'))} also clear${rest.length === 1 ? 's' : ''} the gate.`,
      )
    }
  } else {
    const widest = terms[0]
    parts.push(
      widest
        ? `Nothing separates this engineer: no dimension is a full interquartile range from the ` +
            `cohort median, and the widest, ${widest.label.toLowerCase()} at ` +
            `${Math.abs(widest.deviation).toFixed(1)} ` +
            `${widest.deviation >= 0 ? 'above' : 'below'}, is not a difference.`
        : 'Nothing separates this engineer.',
    )
  }

  if (withheld.length > 0) {
    const names = sentenceList(
      withheld.map((w) => w.label.toLowerCase()),
      'and',
    )
    const plural = withheld.length > 1
    parts.push(
      `${capitalise(names)} ${plural ? 'are' : 'is'} withheld rather than low — no data behind ` +
        `${plural ? 'them' : 'it'}, so the composite is the mean of the other ` +
        `${4 - withheld.length}.`,
    )
  }

  return parts.join(' ')
}

function sentenceList(items: string[], conjunction: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

/**
 * How the org divides between "a dimension explains this placing" and "nothing does".
 *
 * The org-level counterpart to `scoreDrivers`, for the note under a chart. The point
 * of printing it is that in this data the second number is the larger one, and a
 * reader who sees four named drivers without also seeing how many rows have none
 * will conclude the page found a driver for everybody.
 */
export function driverTally(
  rows: { values: RadarValues }[],
): { driven: number; even: number; unscored: number; total: number } {
  const tally = { driven: 0, even: 0, unscored: 0, total: rows.length }
  for (const row of rows) tally[scoreDrivers(row.values).verdict] += 1
  return tally
}
