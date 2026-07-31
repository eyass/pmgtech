/**
 * Tenure normalisation, mirrored from `0028_tenure_normalisation.sql`.
 *
 * The scoring itself happens in Postgres — there is one definition of a score in
 * this system and it is not this file. What lives here is the arithmetic that
 * decides *how much of a window an engineer was present for*, which the SQL and
 * the admin screen both need to agree on:
 *
 *   - the migration divides rate inputs by the presence fraction and drops
 *     below-floor rows out of the cohort median;
 *   - the admin screen has to tell somebody editing a start date what that edit
 *     will do before they commit to it, and refuse a date it cannot use.
 *
 * Two implementations of one rule is a risk, and it is taken for the same reason
 * `rank-bands.ts` restates `score_vs_cohort`'s 15-point interquartile step and
 * `targets.ts` restates 0027's direction check: `node --test` cannot reach
 * Postgres, and an unarguable arithmetic rule with no test is how a proration
 * quietly inverts. Every function below is pure, and the tests in
 * `test/tenure.test.ts` pin the same cases the migration's comments call out.
 */

/**
 * Minimum share of the window an engineer must have been employed for before
 * their row may define their cohort's median or take a place in the ranked set.
 *
 * Mirrors `tenure_presence_floor()` in 0028, which is the authority. The argument
 * for one half, in short: proration divides by the presence fraction, so it scales
 * the noise by 1/f as well as the signal — at 50% the published figure is twice
 * what was observed, at 12% it is 8.2 times it, and a median assembled from rows
 * like the second is a median of extrapolations. Half the window is where the
 * observation still outweighs the inference. The migration's comment carries the
 * full reasoning, including why it is not a `metric_targets` row.
 */
export const MIN_PRESENCE_FRACTION = 0.5

/** A calendar day, as `yyyy-mm-dd`. Dates arrive from Postgres in this shape. */
export type IsoDate = string

const DAY_MS = 86_400_000

/**
 * Whole UTC days between two instants, floored, and never below one.
 *
 * Whole days rather than a fractional span, matching the migration, so the factor
 * the score was divided by and the sentence the row prints ("11 of 90 days") are
 * the same two numbers. A reader who divides them lands on what was applied.
 */
export function windowDays(from: Date | string, to: Date | string): number {
  const a = utcMidnight(from)
  const b = utcMidnight(to)
  return Math.max(Math.round((b - a) / DAY_MS), 1)
}

/**
 * Days of the window on or after the start date, clamped at both ends.
 *
 * Null when there is no start date: unknown presence is not the same as full
 * presence, and returning the window length here would be the silent full-tenure
 * assumption 0028 exists to refuse.
 *
 * Zero — not a negative — for a start date after the window ends. `2026-08-10` is
 * in this database today; a negative would invert every prorated rate and produce
 * a confident, enormous, backwards number.
 */
export function daysPresent(
  startDate: IsoDate | null | undefined,
  from: Date | string,
  to: Date | string,
): number | null {
  if (!startDate) return null
  const start = utcMidnight(startDate)
  if (Number.isNaN(start)) return null
  const a = utcMidnight(from)
  const b = utcMidnight(to)
  const span = Math.max(Math.round((b - a) / DAY_MS), 1)
  const begin = Math.max(start, a)
  return Math.min(Math.max(Math.round((b - begin) / DAY_MS), 0), span)
}

/** Everything the migration derives from a start date and a window, in one shape. */
export interface Presence {
  /** Length of the window in whole days; at least 1. */
  windowDays: number
  /** Days employed inside it, or null when there is no start date on record. */
  daysPresent: number | null
  /** `daysPresent / windowDays`, or null when unknown. */
  fraction: number | null
  /** False when there is no start date: presence cannot be established. */
  known: boolean
  /** True when the start date falls on or after the window's end. */
  notYetPresent: boolean
  /**
   * Whether this row may define its cohort's median and take a rank. Requires a
   * known start date at or above `MIN_PRESENCE_FRACTION`; the boundary is
   * inclusive, so exactly half a window qualifies.
   */
  inCohortMedian: boolean
}

export function presence(
  startDate: IsoDate | null | undefined,
  from: Date | string,
  to: Date | string,
): Presence {
  const span = windowDays(from, to)
  const days = daysPresent(startDate, from, to)
  const fraction = days === null ? null : days / span
  return {
    windowDays: span,
    daysPresent: days,
    fraction,
    known: days !== null,
    notYetPresent: days === 0,
    inCohortMedian: fraction !== null && fraction >= MIN_PRESENCE_FRACTION,
  }
}

/**
 * Restate a count as the rate it implies over a full window.
 *
 * The unit is unchanged, which is the point: a full-presence engineer divides by
 * exactly 1 and their score does not move, so the cohort median stays in the unit
 * it was already in. Null presence returns the value untouched — there is no
 * factor to apply and inventing one would be a fabrication; zero presence returns
 * null, because a rate of zero is a claim about output and there is nothing to
 * claim about someone who had not started.
 */
export function prorate(value: number, fraction: number | null): number | null {
  if (fraction === null) return value
  if (fraction <= 0) return null
  return value / fraction
}

/**
 * Which scoring inputs are prorated and which are not, and why — the same split
 * the migration makes, restated where the app can print it.
 *
 * There is no single rule that covers the second list, which is exactly why it is
 * a list rather than a rule.
 */
export const PRORATION_RULES = {
  prorated: [
    {
      key: 'throughput_units',
      label: 'Merged merge requests (complexity-weighted)',
      why: 'A count of work done, which accumulates with time present.',
    },
    {
      key: 'issues_resolved',
      label: 'Issues resolved',
      why: 'A count of work done, which accumulates with time present.',
    },
    {
      key: 'reviews_given',
      label: 'Reviews given',
      why: 'A count of work done, which accumulates with time present.',
    },
    {
      key: 'reverts_authored',
      label: 'Reverts authored',
      why: 'A count too, and prorated for symmetry: leaving it raw while prorating the other three would hand every short-tenure engineer a free quality score.',
    },
  ],
  unprorated: [
    {
      key: 'review_coverage_received_pct',
      label: 'Review coverage received',
      why: 'Already a percentage of their own merge requests, so time has divided out. Prorating it would push it past 100.',
    },
    {
      key: 'large_mr_pct',
      label: 'Large-MR share',
      why: 'Also a share of their own merge requests.',
    },
    {
      key: 'median_cycle_hours',
      label: 'Median cycle time',
      why: 'Hours per merge request — normalised by the unit of work, not by the period. A short window makes it rest on few merge requests, which the confidence label handles rather than the arithmetic.',
    },
    {
      key: 'distinct_authors_reviewed',
      label: 'Colleagues reviewed for',
      why: 'A count of distinct people, bounded by the size of the org rather than the length of the window. It saturates; it does not accumulate. Scaling three colleagues over eleven days to 24.5 over ninety would name more people than there are.',
    },
  ],
} as const

/**
 * The presence sentence, in the app's voice. Mirrors the `confidence_reason`
 * strings 0028 builds, so the admin screen previewing an edit and the score page
 * explaining it read the same way.
 */
export function describePresence(p: Presence, startDate: IsoDate | null | undefined): string {
  if (!p.known) {
    return 'No start date on record, so how much of the period they were here cannot be established — scored on unadjusted totals and left out of the cohort median'
  }
  if (p.notYetPresent) {
    return `Start date ${startDate} falls after this period — there is nothing here to score`
  }
  const stem = `Present for ${p.daysPresent} of ${p.windowDays} days in this period`
  return p.inCohortMedian
    ? `${stem} — scored normally`
    : `${stem} — their rates are scaled up to a full window, and they are left out of the cohort median so a partial window cannot move their peers`
}

/**
 * Whether a hand-entered start date is usable, and why not when it is not.
 *
 * Deliberately permissive about the future: a signed offer with a start date next
 * month is a real row in this directory today, and 0028 scores it correctly by
 * withholding rather than by refusing to store it. What is refused is a date that
 * cannot be a start date at all, because storing one silently changes every score
 * in that person's cohort in a way nobody would think to look for.
 */
export function validateStartDate(
  value: string,
  today = new Date(),
): { ok: true; date: IsoDate } | { ok: false; message: string } {
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: false, message: 'A start date has to be written as yyyy-mm-dd' }
  }
  const parsed = utcMidnight(trimmed)
  if (Number.isNaN(parsed)) return { ok: false, message: `${trimmed} is not a real date` }
  // Round-trips only for a real calendar day; 2025-02-30 parses and then does not.
  if (new Date(parsed).toISOString().slice(0, 10) !== trimmed) {
    return { ok: false, message: `${trimmed} is not a real date` }
  }
  if (parsed < Date.UTC(2000, 0, 1)) {
    return { ok: false, message: 'A start date before 2000 is a typo, not a tenure' }
  }
  const twoYearsOut = utcMidnight(today) + 730 * DAY_MS
  if (parsed > twoYearsOut) {
    return {
      ok: false,
      message: 'A start date more than two years out is a typo — a future date is fine, this one is not',
    }
  }
  return { ok: true, date: trimmed }
}

function utcMidnight(value: Date | string): number {
  if (value instanceof Date) {
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  }
  // 'yyyy-mm-dd' parses as UTC midnight already; a full timestamp is truncated to
  // its UTC day, matching the migration's `(ts at time zone 'utc')::date`.
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return Number.NaN
  return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
}
