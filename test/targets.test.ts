import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  describeTargetChange,
  getTarget,
  orderedTargets,
  rateAgainstTarget,
  resolveMetricTargets,
  scoreVsTarget,
  scoredTargets,
  validateTarget,
  validateWeight,
  type MetricTargetChangeRow,
  type MetricTargetRow,
} from '../src/lib/targets.ts'
import {
  METRIC_TARGET_DEFAULTS,
  SQUAD_SCORE_RUBRIC,
  TEAM_TARGETS,
  type MetricTargetKey,
} from '../src/lib/types/performance.ts'

/**
 * Targets became editable in `0027_configurable_targets.sql`. Three properties have
 * to hold for that to be a safe change rather than a way to quietly rewrite
 * history, and all three are pinned here:
 *
 *   1. **Day one is byte-identical.** The seed in the migration is exactly the
 *      numbers that were hardcoded, so applying 0027 moves nobody's score. This is
 *      checked by parsing the migration rather than by restating it, because a test
 *      that restates the numbers only proves the test agrees with itself.
 *   2. **A missing target falls back; it never becomes zero.** Zero on a
 *      higher-better metric is a squad that missed every target, and a target that
 *      failed to load must not be able to say that about anyone.
 *   3. **An inverted target is refused.** `good` below `bad` on a higher-better
 *      metric does not error anywhere — it silently maps the 0-100 scale backwards
 *      and keeps rendering a confident number. That is the failure this whole
 *      feature had to be built against.
 */

// --- the migration seed, parsed ----------------------------------------------

interface SeedRow {
  key: string
  good: number
  bad: number
  direction: string
  dimension: string | null
  weight: number | null
}

/**
 * Read the seeded values straight out of the migration.
 *
 * Parsing SQL in a test is not elegant, and the alternative is worse: a second
 * hand-typed copy of thirteen thresholds, which is a second thing to get wrong and
 * proves nothing about the file that will actually run against the database.
 */
function seededTargets(): Map<string, SeedRow> {
  const sql = readFileSync(
    new URL('../supabase/migrations/0027_configurable_targets.sql', import.meta.url),
    'utf8',
  )
  const block = sql.slice(
    sql.indexOf('insert into metric_targets'),
    sql.indexOf("on conflict (metric_key) do nothing"),
  )
  assert.ok(block.length > 0, 'could not find the metric_targets seed in 0027')

  const rows = new Map<string, SeedRow>()
  // ('key', 'label', good, bad, 'direction', dimension_or_null, weight_or_null, sort, ...
  const pattern =
    /\(\s*'([a-z_]+)',\s*'[^']*(?:''[^']*)*',\s*(-?[\d.]+),\s*(-?[\d.]+),\s*'(higher-better|lower-better)',\s*(?:'(throughput|flow|quality|collaboration)'|null),\s*(?:([\d.]+)|null),/g
  for (const match of block.matchAll(pattern)) {
    rows.set(match[1], {
      key: match[1],
      good: Number(match[2]),
      bad: Number(match[3]),
      direction: match[4],
      dimension: match[5] ?? null,
      weight: match[6] === undefined ? null : Number(match[6]),
    })
  }
  return rows
}

describe('0027 seeds exactly the values that were hardcoded', () => {
  const seed = seededTargets()

  it('seeds one row for each metric that had a target in code, and no others', () => {
    assert.deepEqual(
      [...seed.keys()].sort(),
      Object.keys(METRIC_TARGET_DEFAULTS).sort(),
      'the migration seed and the code fallback cover different metrics',
    )
    assert.equal(seed.size, 13)
  })

  it('matches TEAM_TARGETS on every threshold and direction', () => {
    for (const [key, target] of Object.entries(TEAM_TARGETS)) {
      const row = seed.get(key)
      assert.ok(row, `${key} is in TEAM_TARGETS but not seeded`)
      assert.equal(row.good, target.good, `${key} good`)
      assert.equal(row.bad, target.bad, `${key} bad`)
      assert.equal(row.direction, target.direction, `${key} direction`)
    }
  })

  it('matches the squad rubric on every threshold, weight and dimension', () => {
    for (const [dimension, block] of Object.entries(SQUAD_SCORE_RUBRIC)) {
      for (const metric of block.metrics) {
        const row = seed.get(metric.key)
        assert.ok(row, `${metric.key} is scored but not seeded`)
        assert.equal(row.good, metric.good, `${metric.key} good`)
        assert.equal(row.bad, metric.bad, `${metric.key} bad`)
        assert.equal(row.weight, metric.weight, `${metric.key} weight`)
        assert.equal(row.dimension, dimension, `${metric.key} dimension`)
      }
    }
  })

  it('leaves the six unscored metrics with no dimension and no weight', () => {
    for (const row of seed.values()) {
      const scoredInRubric = Object.values(SQUAD_SCORE_RUBRIC).some((block) =>
        block.metrics.some((m) => m.key === row.key),
      )
      if (scoredInRubric) continue
      assert.equal(row.dimension, null, `${row.key} should not feed a dimension`)
      assert.equal(row.weight, null, `${row.key} should carry no weight`)
    }
  })

  it('and the code fallback agrees with the seed row for row', () => {
    for (const [key, base] of Object.entries(METRIC_TARGET_DEFAULTS)) {
      const row = seed.get(key)
      assert.ok(row, `${key} missing from the seed`)
      assert.equal(base.good, row.good, `${key} good`)
      assert.equal(base.bad, row.bad, `${key} bad`)
      assert.equal(base.direction, row.direction, `${key} direction`)
      assert.equal(base.dimension, row.dimension, `${key} dimension`)
      assert.equal(base.weight, row.weight, `${key} weight`)
    }
  })

  it('never grants anon anything', () => {
    const sql = readFileSync(
      new URL('../supabase/migrations/0027_configurable_targets.sql', import.meta.url),
      'utf8',
    )
    for (const line of sql.split('\n')) {
      if (!line.trimStart().startsWith('grant ')) continue
      assert.ok(
        !/\banon\b/.test(line),
        `0027 grants something to anon, and production is publicly reachable: ${line.trim()}`,
      )
    }
    assert.match(sql, /revoke all on table metric_targets\s+from public, anon/)
    assert.match(sql, /revoke all on table metric_target_changes from public, anon/)
  })
})

// --- fallback rather than zero -----------------------------------------------

function row(over: Partial<MetricTargetRow> & { metric_key: string }): MetricTargetRow {
  const base = (METRIC_TARGET_DEFAULTS as Record<string, (typeof METRIC_TARGET_DEFAULTS)[MetricTargetKey] | undefined>)[
    over.metric_key
  ]
  return {
    label: base?.label ?? over.metric_key,
    good: base?.good ?? 1,
    bad: base?.bad ?? 0,
    direction: base?.direction ?? 'higher-better',
    score_dimension: base?.dimension ?? null,
    score_weight: base?.weight ?? null,
    rationale: null,
    sort_order: base?.sortOrder ?? 10,
    updated_at: '2026-07-01T09:00:00Z',
    updated_by: 'someone@petmediagroup.com',
    ...over,
  }
}

function everyKeyStored(): MetricTargetRow[] {
  return Object.keys(METRIC_TARGET_DEFAULTS).map((metric_key) => row({ metric_key }))
}

describe('a target that cannot be read falls back, and never reads as zero', () => {
  it('falls back for every key when the table is unreachable', () => {
    const { targets, usingFallback, problems } = resolveMetricTargets(null, 'connection refused')
    assert.equal(usingFallback, true)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /connection refused/)
    for (const [key, base] of Object.entries(METRIC_TARGET_DEFAULTS)) {
      const resolved = getTarget(targets, key as MetricTargetKey)
      assert.equal(resolved.source, 'fallback')
      assert.equal(resolved.good, base.good, `${key} good`)
      assert.equal(resolved.bad, base.bad, `${key} bad`)
    }
  })

  it('falls back for one missing key while using the stored rows for the rest', () => {
    const stored = everyKeyStored()
      .filter((r) => r.metric_key !== 'mttr_hours')
      .map((r) => (r.metric_key === 'deploys_per_week' ? { ...r, good: 9, bad: 2 } : r))

    const { targets, usingFallback } = resolveMetricTargets(stored)
    assert.equal(usingFallback, false)

    const missing = getTarget(targets, 'mttr_hours')
    assert.equal(missing.source, 'fallback')
    assert.equal(missing.good, METRIC_TARGET_DEFAULTS.mttr_hours.good)
    assert.equal(missing.bad, METRIC_TARGET_DEFAULTS.mttr_hours.bad)
    assert.notEqual(missing.good, 0, 'a missing target must not collapse to zero')
    assert.notEqual(missing.bad, 0, 'a missing target must not collapse to zero')

    const edited = getTarget(targets, 'deploys_per_week')
    assert.equal(edited.source, 'stored')
    assert.equal(edited.good, 9)
  })

  it('does not let a missing target score a squad badly', () => {
    // A squad hitting the seeded target exactly. With the fallback in place it scores
    // 100; if a missing key had become {good: 0, bad: 0} or dropped out entirely, the
    // same squad would read 0 or blank, and a blameless squad would look like the
    // worst in the org.
    const { targets } = resolveMetricTargets([])
    const target = getTarget(targets, 'mttr_hours')
    assert.equal(scoreVsTarget(target, METRIC_TARGET_DEFAULTS.mttr_hours.good), 100)
    assert.equal(rateAgainstTarget(target, METRIC_TARGET_DEFAULTS.mttr_hours.good), 'good')
  })

  it('reports an empty table separately from an unreachable one', () => {
    const empty = resolveMetricTargets([])
    assert.equal(empty.usingFallback, true)
    assert.match(empty.problems.join(' '), /0027/)
    assert.doesNotMatch(empty.problems.join(' '), /could not be read/)
  })

  it('keeps a stored metric the code has never heard of, and says it has no cover', () => {
    const stored = [
      ...everyKeyStored(),
      row({
        metric_key: 'incident_count',
        label: 'Incidents',
        good: 0,
        bad: 5,
        direction: 'lower-better',
        score_dimension: null,
        score_weight: null,
      }),
    ]
    const { targets, problems } = resolveMetricTargets(stored)
    assert.equal(targets.incident_count.source, 'stored')
    assert.equal(targets.incident_count.good, 0)
    assert.match(problems.join(' '), /no code fallback/)
  })
})

// --- inverted targets are refused, not silently applied ----------------------

describe('an inverted target is rejected rather than scoring everything backwards', () => {
  it('refuses good below bad on a higher-better metric', () => {
    const check = validateTarget({ direction: 'higher-better', good: 1, bad: 4, label: 'Deploys' })
    assert.equal(check.ok, false)
    assert.match((check as { message: string }).message, /higher-better/)
    assert.match((check as { message: string }).message, /backwards/)
  })

  it('refuses good above bad on a lower-better metric', () => {
    const check = validateTarget({
      direction: 'lower-better',
      good: 200,
      bad: 24,
      label: 'Cycle time',
    })
    assert.equal(check.ok, false)
    assert.match((check as { message: string }).message, /lower-better/)
  })

  it('refuses an empty range, which would withhold the metric for every squad', () => {
    const check = validateTarget({ direction: 'higher-better', good: 5, bad: 5 })
    assert.equal(check.ok, false)
    assert.match((check as { message: string }).message, /same number/)
  })

  it('refuses values that are not numbers', () => {
    assert.equal(validateTarget({ direction: 'higher-better', good: NaN, bad: 1 }).ok, false)
    assert.equal(
      validateTarget({ direction: 'lower-better', good: 1, bad: Number.POSITIVE_INFINITY }).ok,
      false,
    )
  })

  it('accepts every seeded target, in both directions', () => {
    for (const base of Object.values(METRIC_TARGET_DEFAULTS)) {
      const check = validateTarget(base)
      assert.equal(check.ok, true, `${base.key} should be valid: ${JSON.stringify(check)}`)
    }
  })

  it('keeps the fallback and flags the row when an inverted target is already stored', () => {
    const stored = everyKeyStored().map((r) =>
      // The pair a CHECK constraint should have refused, arriving anyway.
      r.metric_key === 'deploys_per_week' ? { ...r, good: 1, bad: 5 } : r,
    )
    const { targets, problems } = resolveMetricTargets(stored)
    const resolved = getTarget(targets, 'deploys_per_week')

    assert.equal(resolved.source, 'fallback')
    assert.equal(resolved.good, METRIC_TARGET_DEFAULTS.deploys_per_week.good)
    assert.ok(resolved.rejected, 'the refusal should be visible on the row, not only in the list')
    assert.match(problems.join(' '), /backwards/)

    // The point of refusing it: a squad deploying five times a week is excellent, and
    // under the inverted target it would have scored zero.
    assert.equal(scoreVsTarget(resolved, 5), 100)
    assert.equal(rateAgainstTarget(resolved, 5), 'good')
  })

  it('refuses a weight that is zero, negative or attached to an unscored metric', () => {
    assert.equal(validateWeight({ dimension: 'throughput', weight: 0 }).ok, false)
    assert.equal(validateWeight({ dimension: 'throughput', weight: -1 }).ok, false)
    assert.equal(validateWeight({ dimension: 'throughput', weight: null }).ok, false)
    assert.equal(validateWeight({ dimension: null, weight: 2 }).ok, false)
    assert.equal(validateWeight({ dimension: null, weight: null }).ok, true)
    assert.equal(validateWeight({ dimension: 'quality', weight: 1 }).ok, true)
  })
})

// --- the arithmetic, mirrored from 0021 --------------------------------------

describe('scoreVsTarget mirrors score_vs_target in SQL', () => {
  it('puts bad at 0, good at 100 and the midpoint at 50, in both directions', () => {
    const higher = { good: 5, bad: 1, direction: 'higher-better' as const }
    assert.equal(scoreVsTarget(higher, 1), 0)
    assert.equal(scoreVsTarget(higher, 3), 50)
    assert.equal(scoreVsTarget(higher, 5), 100)

    const lower = { good: 24, bad: 120, direction: 'lower-better' as const }
    assert.equal(scoreVsTarget(lower, 120), 0)
    assert.equal(scoreVsTarget(lower, 72), 50)
    assert.equal(scoreVsTarget(lower, 24), 100)
  })

  it('clamps outside the range, so one spectacular value cannot buy back points', () => {
    const higher = { good: 5, bad: 1, direction: 'higher-better' as const }
    assert.equal(scoreVsTarget(higher, 500), 100)
    assert.equal(scoreVsTarget(higher, -20), 0)
  })

  it('withholds rather than zeroes for a null value or an empty range', () => {
    const higher = { good: 5, bad: 1, direction: 'higher-better' as const }
    assert.equal(scoreVsTarget(higher, null), null)
    assert.equal(scoreVsTarget({ good: 5, bad: 5, direction: 'higher-better' }, 5), null)
  })

  it('leaves a missing value uncoloured rather than red', () => {
    assert.equal(rateAgainstTarget(METRIC_TARGET_DEFAULTS.mttr_hours, null), 'neutral')
    assert.equal(rateAgainstTarget(METRIC_TARGET_DEFAULTS.mttr_hours, undefined), 'neutral')
  })
})

// --- the audit trail reads as an explanation ---------------------------------

function change(over: Partial<MetricTargetChangeRow>): MetricTargetChangeRow {
  return {
    id: 'c1',
    metric_key: 'mrs_per_engineer_week',
    changed_by: 'eyass@petmediagroup.com',
    changed_at: '2026-07-20T10:00:00Z',
    old_good: 4,
    old_bad: 1,
    new_good: 4,
    new_bad: 1,
    old_weight: 2,
    new_weight: 2,
    direction: 'higher-better',
    note: null,
    ...over,
  }
}

describe('the change history explains a score move rather than just recording one', () => {
  const { targets } = resolveMetricTargets(everyKeyStored())

  it('calls a higher good on a higher-better metric stricter', () => {
    const described = describeTargetChange(change({ new_good: 6 }), targets)
    assert.equal(described.severity, 'stricter')
    assert.match(described.summary, /good 4 → 6/)
  })

  it('calls a higher good on a lower-better metric looser', () => {
    const described = describeTargetChange(
      change({ metric_key: 'median_cycle_hours', direction: 'lower-better', old_good: 24, new_good: 48, old_bad: 120, new_bad: 120, old_weight: 1, new_weight: 1 }),
      targets,
    )
    assert.equal(described.severity, 'looser')
  })

  it('calls one end tightening and the other loosening mixed', () => {
    const described = describeTargetChange(change({ new_good: 6, new_bad: 0.5 }), targets)
    assert.equal(described.severity, 'mixed')
  })

  it('separates a pure reweighting from a threshold move', () => {
    const described = describeTargetChange(change({ new_weight: 3 }), targets)
    assert.equal(described.severity, 'reweighted')
    assert.match(described.summary, /weight 2 → 3/)
  })

  it('quantifies the move against a squad that did not change at all', () => {
    // good 4 -> 6 with bad at 1: a squad still shipping 4 per engineer per week used
    // to score 100 and now scores 60. That sentence is the whole point of the trail.
    const described = describeTargetChange(change({ new_good: 6 }), targets)
    assert.match(described.impact ?? '', /now scores 60 out of 100/)
  })

  it('reads the bad end the same way round as the good end', () => {
    // Raising the floor on a higher-better metric is stricter — a squad at 1 used to
    // score 0 and now scores below it — even though nothing about `good` moved.
    const stricter = describeTargetChange(change({ new_bad: 2 }), targets)
    assert.equal(stricter.severity, 'stricter')
    assert.equal(
      stricter.impact,
      null,
      'a squad sitting on the unchanged good still scores 100, so there is nothing to quantify',
    )
    // Lowering it is the reverse: a squad that was scoring 0 gets points back.
    assert.equal(describeTargetChange(change({ new_bad: 0.5 }), targets).severity, 'looser')
  })

  it('carries the actor and the reason through untouched', () => {
    const described = describeTargetChange(
      change({ new_good: 6, changed_by: 'unknown', note: 'Board asked for a stretch target' }),
      targets,
    )
    assert.equal(described.changedBy, 'unknown')
    assert.equal(described.note, 'Board asked for a stretch target')
    assert.equal(described.label, METRIC_TARGET_DEFAULTS.mrs_per_engineer_week.label)
  })
})

// --- ordering ----------------------------------------------------------------

describe('target ordering', () => {
  it('lists the seven scored metrics first, grouped by dimension', () => {
    const { targets } = resolveMetricTargets(everyKeyStored())
    const ordered = orderedTargets(targets)
    assert.equal(ordered.length, 13)
    assert.deepEqual(
      scoredTargets(targets).map((t) => t.key),
      ordered.slice(0, 7).map((t) => t.key),
    )
    assert.deepEqual(
      [...new Set(scoredTargets(targets).map((t) => t.dimension))],
      ['throughput', 'flow', 'quality', 'collaboration'],
    )
  })
})
