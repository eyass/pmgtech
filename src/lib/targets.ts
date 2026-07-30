// Relative, with the extension, for the same reason `radar-geometry.ts` imports
// `chart-scale.ts` that way: `node --test` strips types but does not resolve the
// `@/` alias, and METRIC_TARGET_DEFAULTS is a value rather than a type.
import {
  METRIC_TARGET_DEFAULTS,
  type MetricDirection,
  type MetricTarget,
  type MetricTargetDefault,
  type MetricTargetKey,
  type SquadScoreDimension,
} from './types/performance.ts'

/**
 * Delivery targets, resolved.
 *
 * Since `0027_configurable_targets.sql` the thresholds a squad is scored against
 * are rows in `metric_targets`, editable from the admin screen. The constants in
 * `lib/types/performance.ts` stayed exactly where they were and became the
 * fallback. This module is the join between the two, and it exists as pure
 * functions with no Supabase import so the merge rules are testable without a
 * database — `lib/queries.ts` does the reading and hands rows in here.
 *
 * The rule that shapes everything below: **a target that cannot be read must
 * never make a squad look bad.** There are three ways that could happen and all
 * three are closed here.
 *
 *   - The table is unreachable. Every key falls back, `usingFallback` is true, and
 *     the admin screen says so out loud rather than showing thirteen numbers that
 *     are not the ones in use.
 *   - A key has no row. That key alone falls back. It does not become zero, and it
 *     does not drop out and quietly leave the metric uncoloured.
 *   - A row is stored inverted — `good` below `bad` on a higher-better metric.
 *     0027 has a CHECK constraint that should make this impossible, but a
 *     constraint added later than the data is not a guarantee about the data, so
 *     the row is refused here too and the fallback stands. Accepting it would flip
 *     the 0-100 mapping and score every squad backwards while still rendering a
 *     confident number, which is the worst available outcome.
 */

// --- rows, as they arrive from Postgres --------------------------------------

export interface MetricTargetRow {
  metric_key: string
  label: string
  good: number | string
  bad: number | string
  direction: string
  score_dimension: string | null
  score_weight: number | string | null
  rationale: string | null
  sort_order: number
  updated_at: string | null
  updated_by: string | null
}

export interface MetricTargetChangeRow {
  id: string
  metric_key: string
  changed_by: string
  changed_at: string
  old_good: number | string
  old_bad: number | string
  new_good: number | string
  new_bad: number | string
  old_weight: number | string | null
  new_weight: number | string | null
  direction: string
  note: string | null
}

// --- resolved shape ----------------------------------------------------------

export interface ResolvedTarget extends MetricTargetDefault {
  /** Whether the numbers above came from the table or from the code fallback. */
  source: 'stored' | 'fallback'
  /** Why the target is stated, kept beside it so an argument has something to argue with. */
  rationale: string | null
  updatedAt: string | null
  updatedBy: string | null
  /**
   * Set when a stored row existed and was refused. Distinct from a plain fallback:
   * this one is a fault worth showing on screen, because someone tried to set a
   * target and the product is not using it.
   */
  rejected: string | null
}

export type MetricTargetSet = Record<string, ResolvedTarget>

export interface MetricTargetResolution {
  targets: MetricTargetSet
  /** True when nothing at all was read — the table was unreachable or empty. */
  usingFallback: boolean
  /** Human-readable faults: an unreachable table, a refused row, an unknown key. */
  problems: string[]
}

// --- validation --------------------------------------------------------------

export type TargetValidation = { ok: true } | { ok: false; message: string }

/**
 * Reject a target pair that would score backwards, or not score at all.
 *
 * `direction` is not editable — it is a property of the metric — so this is only
 * ever asked whether `good` and `bad` sit on the right sides of each other for the
 * direction the metric already has. The mirror of this check is a CHECK constraint
 * and a `raise exception` in 0027; this copy exists so the admin screen can refuse
 * an edit with a sentence instead of surfacing a constraint name.
 */
export function validateTarget(input: {
  direction: MetricDirection
  good: number
  bad: number
  label?: string
}): TargetValidation {
  const name = input.label ?? 'This target'
  if (!Number.isFinite(input.good) || !Number.isFinite(input.bad)) {
    return { ok: false, message: `${name} needs a number for both good and bad.` }
  }
  if (input.good === input.bad) {
    return {
      ok: false,
      message: `${name}: good and bad cannot be the same number — there would be no range to score across, so every squad would go uncoloured.`,
    }
  }
  if (input.direction === 'higher-better' && input.good < input.bad) {
    return {
      ok: false,
      message: `${name} is higher-better, so good (${input.good}) has to be above bad (${input.bad}). The other way round every squad would be scored backwards.`,
    }
  }
  if (input.direction === 'lower-better' && input.good > input.bad) {
    return {
      ok: false,
      message: `${name} is lower-better, so good (${input.good}) has to be below bad (${input.bad}). The other way round every squad would be scored backwards.`,
    }
  }
  return { ok: true }
}

/** Weights only mean something inside a dimension, and only above zero. */
export function validateWeight(input: {
  dimension: SquadScoreDimension | null
  weight: number | null
  label?: string
}): TargetValidation {
  const name = input.label ?? 'This target'
  if (input.dimension === null) {
    if (input.weight !== null) {
      return { ok: false, message: `${name} is not part of the squad score, so it has no weight.` }
    }
    return { ok: true }
  }
  if (input.weight === null || !Number.isFinite(input.weight) || input.weight <= 0) {
    return { ok: false, message: `${name} needs a weight above zero.` }
  }
  return { ok: true }
}

// --- resolution --------------------------------------------------------------

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function fallbackEntry(base: MetricTargetDefault): ResolvedTarget {
  return {
    ...base,
    source: 'fallback',
    rationale: null,
    updatedAt: null,
    updatedBy: null,
    rejected: null,
  }
}

function fallbackSet(): MetricTargetSet {
  const out: MetricTargetSet = {}
  for (const base of Object.values(METRIC_TARGET_DEFAULTS)) out[base.key] = fallbackEntry(base)
  return out
}

function asDirection(value: string, fallback: MetricDirection): MetricDirection {
  return value === 'higher-better' || value === 'lower-better' ? value : fallback
}

function asDimension(value: string | null): SquadScoreDimension | null {
  return value === 'throughput' || value === 'flow' || value === 'quality' || value === 'collaboration'
    ? value
    : null
}

/**
 * Layer stored rows over the code fallback.
 *
 * `rows` is null when the read itself failed, and an empty array when the table is
 * there but has nothing in it. Both end up on the fallback, and both are reported,
 * because "the migration has not run yet" and "Postgres is down" look identical
 * from a page but are not the same problem to fix.
 */
export function resolveMetricTargets(
  rows: MetricTargetRow[] | null,
  readError?: string | null,
): MetricTargetResolution {
  const targets = fallbackSet()
  const problems: string[] = []

  if (rows === null) {
    problems.push(
      `Stored targets could not be read${readError ? ` (${readError})` : ''}. Showing the built-in defaults, which is what the app is scoring against right now.`,
    )
    return { targets, usingFallback: true, problems }
  }

  let applied = 0
  for (const row of rows) {
    const base = (METRIC_TARGET_DEFAULTS as Record<string, MetricTargetDefault | undefined>)[
      row.metric_key
    ]
    const good = num(row.good)
    const bad = num(row.bad)
    const weight = num(row.score_weight)
    const dimension = asDimension(row.score_dimension)

    if (good === null || bad === null) {
      problems.push(
        `${row.label || row.metric_key}: stored target is not a number, so the default stands.`,
      )
      continue
    }

    const inferred: MetricDirection = good > bad ? 'higher-better' : 'lower-better'
    const direction = asDirection(row.direction, base?.direction ?? inferred)

    const check = validateTarget({ direction, good, bad, label: row.label || row.metric_key })
    if (!check.ok) {
      problems.push(`${check.message} The default is being used instead.`)
      if (base) targets[base.key] = { ...fallbackEntry(base), rejected: check.message }
      continue
    }

    const resolved: ResolvedTarget = {
      key: (base?.key ?? row.metric_key) as MetricTargetKey,
      label: row.label || base?.label || row.metric_key,
      good,
      bad,
      direction,
      dimension,
      weight: dimension === null ? null : weight,
      sortOrder: row.sort_order ?? base?.sortOrder ?? 999,
      source: 'stored',
      rationale: row.rationale,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      rejected: null,
    }
    // A key the code has never heard of is kept rather than dropped: a later
    // migration can add a metric, and the admin screen should be able to edit it
    // before anything in TypeScript knows its name.
    if (!base) {
      problems.push(
        `${resolved.label} has a stored target but no code fallback. It is editable here, but nothing would cover it if the table went away.`,
      )
    }
    targets[row.metric_key] = resolved
    applied += 1
  }

  if (applied === 0) {
    problems.push(
      'No usable stored targets were found. Showing the built-in defaults — check that migration 0027 has been applied.',
    )
  }

  return { targets, usingFallback: applied === 0, problems }
}

/**
 * Never undefined for a known key: the fallback sits behind every one of them, so
 * a caller cannot accidentally treat a missing target as a zero.
 */
export function getTarget(targets: MetricTargetSet, key: MetricTargetKey): ResolvedTarget {
  return targets[key] ?? fallbackEntry(METRIC_TARGET_DEFAULTS[key])
}

/** The whole set in the order the admin screen and the rubric list it. */
export function orderedTargets(targets: MetricTargetSet): ResolvedTarget[] {
  return Object.values(targets).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
  )
}

/** Just the seven that feed the squad composite, grouped the way the score is. */
export function scoredTargets(targets: MetricTargetSet): ResolvedTarget[] {
  return orderedTargets(targets).filter((t) => t.dimension !== null)
}

// --- scoring, mirrored from SQL ---------------------------------------------

/**
 * `score_vs_target(v, good, bad)` from 0021, in TypeScript.
 *
 * Not used to produce any score the product ranks on — that stays in Postgres. It
 * is here so the admin screen can answer the question an audit trail is for: a
 * target moved, so what does that do to a squad sitting on a given number? Showing
 * the answer is the difference between an audit trail and a changelog.
 */
export function scoreVsTarget(target: MetricTarget, value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || target.good === target.bad) return null
  const raw = (100 * (value - target.bad)) / (target.good - target.bad)
  return Math.round(Math.max(0, Math.min(100, raw)))
}

/** Rate a value against a target for colouring. Squads only — never people. */
export function rateAgainstTarget(
  target: MetricTarget,
  value: number | null | undefined,
): 'good' | 'warn' | 'bad' | 'neutral' {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'neutral'
  if (target.direction === 'higher-better') {
    if (value >= target.good) return 'good'
    if (value <= target.bad) return 'bad'
    return 'warn'
  }
  if (value <= target.good) return 'good'
  if (value >= target.bad) return 'bad'
  return 'warn'
}

// --- reading the audit trail -------------------------------------------------

export type ChangeSeverity = 'stricter' | 'looser' | 'mixed' | 'reweighted' | 'unchanged'

export interface TargetChange {
  id: string
  metricKey: string
  label: string
  changedBy: string
  changedAt: string
  direction: MetricDirection
  oldGood: number
  oldBad: number
  newGood: number
  newBad: number
  oldWeight: number | null
  newWeight: number | null
  note: string | null
  severity: ChangeSeverity
  /** One line naming what moved, e.g. "good 4 → 6, bad unchanged". */
  summary: string
  /**
   * What the move did to a squad that did not change at all: the score a squad
   * sitting exactly on the old `good` gets under the new target. Null when the
   * change cannot move a score. This is the sentence that stops a target edit
   * being mistaken for a squad getting worse.
   */
  impact: string | null
}

/** Did this end of the target get harder to hit? */
function harder(direction: MetricDirection, before: number, after: number): -1 | 0 | 1 {
  if (before === after) return 0
  const rose = after > before
  const stricter = direction === 'higher-better' ? rose : !rose
  return stricter ? 1 : -1
}

/**
 * Turn an audit row into something a person can read.
 *
 * The severity is the load-bearing part. "good 4 → 6" is a fact nobody can act on;
 * "stricter" is what explains why four squads dropped nine points overnight
 * without any of them changing how they work.
 */
export function describeTargetChange(
  row: MetricTargetChangeRow,
  targets: MetricTargetSet,
): TargetChange {
  const base = (METRIC_TARGET_DEFAULTS as Record<string, MetricTargetDefault | undefined>)[
    row.metric_key
  ]
  const direction = asDirection(row.direction, base?.direction ?? 'higher-better')
  const oldGood = num(row.old_good) ?? 0
  const oldBad = num(row.old_bad) ?? 0
  const newGood = num(row.new_good) ?? 0
  const newBad = num(row.new_bad) ?? 0
  const oldWeight = num(row.old_weight)
  const newWeight = num(row.new_weight)

  const moves = [harder(direction, oldGood, newGood), harder(direction, oldBad, newBad)]
  const stricter = moves.filter((m) => m === 1).length
  const looser = moves.filter((m) => m === -1).length
  const weightMoved = oldWeight !== newWeight

  let severity: ChangeSeverity
  if (stricter > 0 && looser > 0) severity = 'mixed'
  else if (stricter > 0) severity = 'stricter'
  else if (looser > 0) severity = 'looser'
  else if (weightMoved) severity = 'reweighted'
  else severity = 'unchanged'

  const parts: string[] = []
  if (oldGood !== newGood) parts.push(`good ${oldGood} → ${newGood}`)
  if (oldBad !== newBad) parts.push(`bad ${oldBad} → ${newBad}`)
  if (weightMoved) parts.push(`weight ${oldWeight ?? '—'} → ${newWeight ?? '—'}`)

  // Scored at the old 100 mark under the new target: the cleanest statement of how
  // far the yardstick moved, because the squad in the example did nothing at all.
  const at = scoreVsTarget({ good: newGood, bad: newBad, direction }, oldGood)
  const impact =
    at === null || at === 100 || oldGood === newGood
      ? null
      : `A squad sitting exactly on the old target (${oldGood}) now scores ${at} out of 100 on this metric instead of 100.`

  return {
    id: row.id,
    metricKey: row.metric_key,
    label: targets[row.metric_key]?.label ?? base?.label ?? row.metric_key,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    direction,
    oldGood,
    oldBad,
    newGood,
    newBad,
    oldWeight,
    newWeight,
    note: row.note,
    severity,
    summary: parts.length > 0 ? parts.join(', ') : 'no numeric change recorded',
    impact,
  }
}

export const SEVERITY_MEANING: Record<ChangeSeverity, string> = {
  stricter: 'Harder to score well on than before. Scores fall without anything about a squad changing.',
  looser: 'Easier to score well on than before. Scores rise without anything about a squad changing.',
  mixed: 'One end got harder and the other easier. Which way a squad moves depends on where it sits.',
  reweighted: 'The thresholds held; only how much this metric counts inside its dimension changed.',
  unchanged: 'Recorded, but nothing that moves a score.',
}
