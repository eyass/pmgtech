import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MATERIAL_SCORE_GAP } from '../src/lib/rank-bands.ts'
import {
  buildSeries,
  captureDays,
  comparableRun,
  describeTrend,
  rankMovers,
  scoreTrend,
  trendBadge,
  versionBoundaries,
  versionRuns,
  type ScorePoint,
  type ScoreSeries,
} from '../src/lib/score-history.ts'
import { captureX, rankTieOffsets, rankY, tieOffsetGrid } from '../src/lib/trend-geometry.ts'

/**
 * The three ways a trend chart lies, pinned so they cannot come back.
 *
 * Each is a mistake that renders as a perfectly plausible picture: a delta inside the
 * noise reads as a movement, a delta across a formula change reads as a movement that
 * is not even measuring the same thing, and a tie drawn without fanning reads as one
 * subject where there are two — the second of them silently absent from a chart that
 * looks complete.
 *
 * The scores are this org's real ones, read out of `engineer_score_snapshots` for the
 * single seeded capture on 2026-07-31. Eleven of fourteen sit inside 6.6 points, and
 * Alan Patekar and Mehmet Cetin both hold rank 6 on exactly 50.8 — the tie is real
 * data, not a constructed edge case.
 */

const V1 = '0024-authored-churn'
const V2 = '0026-hypothetical-next'

function point(
  day: string,
  score: number | null,
  rank: number | null = null,
  version = V1,
  confidence: 'high' | 'thin' | 'no_cohort' = 'high',
): ScorePoint {
  return {
    capturedFor: day,
    definitionVersion: version,
    score,
    rankInOrg: rank,
    confidence,
    confidenceReason: null,
  }
}

function series(id: string, name: string, points: ScorePoint[]): ScoreSeries {
  return { id, name, shortName: name.split(' ')[0]!, points }
}

// --- one capture, which is the state the database is actually in ---------------

describe('a single capture is an absence, not a flat line', () => {
  it('reports one-capture rather than a zero change', () => {
    const trend = scoreTrend([point('2026-07-31', 50.8, 6)])
    assert.equal(trend.kind, 'one-capture')
    // The failure this guards against: 'immaterial' with change 0, which every
    // renderer would draw as a flat line through a measurement nobody took twice.
    assert.notEqual(trend.kind, 'immaterial')
    assert.match(trendBadge(trend), /first capture/)
    assert.match(describeTrend(trend), /no backfill/)
  })

  it('says nothing at all when the one capture has no score', () => {
    const trend = scoreTrend([point('2026-07-31', null, null)])
    assert.equal(trend.kind, 'no-history')
  })

  it('leaves a version run of one undrawable, so nothing is joined to it', () => {
    const runs = versionRuns([point('2026-07-31', 50.8, 6)])
    assert.equal(runs.length, 1)
    assert.equal(runs[0]!.length, 1)
  })
})

// --- the materiality gate -------------------------------------------------------

describe('a delta is gated at one interquartile range', () => {
  it('uses the app-wide gap rather than a second threshold of its own', () => {
    const trend = scoreTrend([point('2026-06-30', 50.8, 6), point('2026-07-31', 69.8, 1)])
    assert.equal(trend.kind, 'material')
    assert.equal(trend.kind === 'material' && trend.gap, MATERIAL_SCORE_GAP)
  })

  it('refuses the whole real spread of this org, which is 6.6 points', () => {
    // Aleksandra's 69.8 down to Irina's 46.9 is the *cohort* spread; the eleven in the
    // middle sit inside 6.6 of each other, and a capture-to-capture move of that size
    // is the case this gate exists for.
    const trend = scoreTrend([point('2026-06-30', 53.5, 3), point('2026-07-31', 46.9, 13)])
    assert.equal(trend.kind, 'immaterial')
    assert.ok(trend.kind === 'immaterial' && Math.abs(trend.change) < MATERIAL_SCORE_GAP)
    assert.equal(trendBadge(trend), 'no material change')
    assert.match(describeTrend(trend), /noise/)
  })

  it('does not round its way over the line', () => {
    const just_under = scoreTrend([point('2026-06-30', 40), point('2026-07-31', 54.9)])
    const exactly = scoreTrend([point('2026-06-30', 40), point('2026-07-31', 55)])
    assert.equal(just_under.kind, 'immaterial')
    assert.equal(exactly.kind, 'material')
  })

  it('measures across the whole comparable run, not just the last two captures', () => {
    // 40 → 48 → 56 is three small steps and one real movement. Reading only the last
    // pair would call it noise and hide a 16-point climb.
    const trend = scoreTrend([
      point('2026-05-31', 40, 12),
      point('2026-06-30', 48, 8),
      point('2026-07-31', 56, 3),
    ])
    assert.equal(trend.kind, 'material')
    assert.equal(trend.kind === 'material' && Math.round(trend.change), 16)
    assert.equal(trend.kind === 'material' && trend.direction, 'up')
  })

  it('signs a fall as a fall', () => {
    const trend = scoreTrend([point('2026-06-30', 69.8, 1), point('2026-07-31', 46.9, 13)])
    assert.equal(trend.kind, 'material')
    assert.equal(trend.kind === 'material' && trend.direction, 'down')
    assert.ok(trend.kind === 'material' && trend.change < 0)
  })
})

// --- the version boundary --------------------------------------------------------

describe('no delta is ever drawn across a definition_version boundary', () => {
  const acrossABoundary = [point('2026-06-30', 40, 12, V1), point('2026-07-31', 62, 2, V2)]

  it('refuses a 22-point difference that would otherwise be the biggest mover', () => {
    const trend = scoreTrend(acrossABoundary)
    assert.equal(trend.kind, 'redefined')
    // The two failures this guards against, named explicitly: it must not be a
    // movement, and it must not be "no change" either.
    assert.notEqual(trend.kind, 'material')
    assert.notEqual(trend.kind, 'immaterial')
  })

  it('names both formulas so the refusal can be understood', () => {
    const trend = scoreTrend(acrossABoundary)
    assert.equal(trend.kind === 'redefined' && trend.previous.definitionVersion, V1)
    assert.equal(trend.kind === 'redefined' && trend.at.definitionVersion, V2)
    assert.match(describeTrend(trend), new RegExp(V1))
    assert.match(describeTrend(trend), new RegExp(V2))
    assert.equal(trendBadge(trend), 'new definition')
  })

  it('refuses a difference that is inside the noise as well, rather than calling it steady', () => {
    const trend = scoreTrend([point('2026-06-30', 50.8, 6, V1), point('2026-07-31', 50.9, 6, V2)])
    assert.equal(trend.kind, 'redefined')
  })

  it('keeps comparing once two captures share the new formula', () => {
    const trend = scoreTrend([
      point('2026-05-31', 40, 12, V1),
      point('2026-06-30', 50, 7, V2),
      point('2026-07-31', 68, 1, V2),
    ])
    assert.equal(trend.kind, 'material')
    // Measured from the first capture under the new formula, not from the old one.
    assert.equal(trend.kind === 'material' && trend.from.score, 50)
    assert.equal(trend.kind === 'material' && trend.from.capturedFor, '2026-06-30')
  })

  it('never lets the comparable run reach behind a boundary', () => {
    const run = comparableRun([
      point('2026-05-31', 40, 12, V1),
      point('2026-06-30', 50, 7, V2),
      point('2026-07-31', 68, 1, V2),
    ])
    assert.deepEqual(
      run.map((p) => p.capturedFor),
      ['2026-06-30', '2026-07-31'],
    )
  })

  it('splits the drawn line at the boundary instead of joining it', () => {
    const points = [
      point('2026-05-31', 40, 12, V1),
      point('2026-06-30', 44, 10, V1),
      point('2026-07-31', 68, 1, V2),
    ]
    const runs = versionRuns(points)
    assert.equal(runs.length, 2)
    assert.deepEqual(runs.map((r) => r.length), [2, 1])
    assert.deepEqual(versionBoundaries(points), ['2026-07-31'])
  })

  it('refuses a formula that changed and changed back, which is two boundaries', () => {
    const trend = scoreTrend([
      point('2026-05-31', 40, 12, V1),
      point('2026-06-30', 55, 5, V2),
      point('2026-07-31', 41, 11, V1),
    ])
    // The two V1 captures carry the same version string and are arguably comparable,
    // but a boundary lies between them. The conservative answer is the one on screen.
    assert.equal(trend.kind, 'redefined')
  })
})

// --- the tie geometry -------------------------------------------------------------

describe('a shared rank keeps both subjects on the chart', () => {
  // Alan Patekar and Mehmet Cetin, rank 6, score 50.8, in the only real capture.
  const tied = [
    { id: 'alan', rank: 6 },
    { id: 'mehmet', rank: 6 },
    { id: 'nikola', rank: 5 },
    { id: 'mariam', rank: 8 },
  ]

  it('fans the tied pair apart and leaves everybody else alone', () => {
    const offsets = rankTieOffsets(tied, 11)
    assert.notEqual(offsets.get('alan'), offsets.get('mehmet'))
    assert.equal(offsets.get('nikola'), 0)
    assert.equal(offsets.get('mariam'), 0)
  })

  it('centres the pair on the rank they share rather than demoting one of them', () => {
    const offsets = rankTieOffsets(tied, 11)
    const a = offsets.get('alan')!
    const m = offsets.get('mehmet')!
    assert.equal(a + m, 0)
    assert.equal(Math.abs(a - m), 11)
    assert.equal(Math.abs(a), 5.5)
  })

  it('stays inside its own rank row, so a fanned tie never reads as the rank above', () => {
    const rowStep = 30
    const offsets = rankTieOffsets(tied, 11)
    for (const offset of offsets.values()) {
      assert.ok(Math.abs(offset) < rowStep / 2, `offset ${offset} escapes its row`)
    }
  })

  it('is deterministic under a permuted input, so a tie does not swap sides per render', () => {
    const a = rankTieOffsets(tied, 11)
    const b = rankTieOffsets([...tied].reverse(), 11)
    for (const id of ['alan', 'mehmet', 'nikola', 'mariam']) {
      assert.equal(a.get(id), b.get(id), `${id} moved between renders`)
    }
  })

  it('separates three on one rank without collapsing the middle one onto a neighbour', () => {
    const offsets = rankTieOffsets(
      [
        { id: 'a', rank: 6 },
        { id: 'b', rank: 6 },
        { id: 'c', rank: 6 },
      ],
      11,
    )
    const values = [...offsets.values()].sort((x, y) => x - y)
    assert.deepEqual(values, [-11, 0, 11])
  })

  it('gives coincident lines distinct pixel positions at every capture', () => {
    const days = ['2026-06-30', '2026-07-31']
    const subjects = [
      { id: 'alan', rankOn: () => 6 },
      { id: 'mehmet', rankOn: () => 6 },
    ]
    const grid = tieOffsetGrid(days, subjects, 11)
    for (const day of days) {
      const a = rankY(6, 14, 46, 46 + 13 * 30) + grid.get(`${day}|alan`)!
      const m = rankY(6, 14, 46, 46 + 13 * 30) + grid.get(`${day}|mehmet`)!
      assert.notEqual(a, m)
      // Far enough apart that each line keeps a hit strip of its own; an overlap is
      // how a pointer event ends up belonging to whichever line was drawn last.
      assert.ok(Math.abs(a - m) >= 11)
    }
  })

  it('drops a tie apart again when the ranks separate', () => {
    const grid = tieOffsetGrid(
      ['2026-06-30', '2026-07-31'],
      [
        { id: 'alan', rankOn: (day: string) => (day === '2026-06-30' ? 6 : 6) },
        { id: 'mehmet', rankOn: (day: string) => (day === '2026-06-30' ? 6 : 3) },
      ],
      11,
    )
    assert.notEqual(grid.get('2026-06-30|alan'), grid.get('2026-06-30|mehmet'))
    assert.equal(grid.get('2026-07-31|alan'), 0)
    assert.equal(grid.get('2026-07-31|mehmet'), 0)
  })

  it('ignores a subject with no rank instead of placing it on the axis', () => {
    const offsets = rankTieOffsets([{ id: 'security', rank: null }], 11)
    assert.equal(offsets.size, 0)
  })
})

describe('the rank axis is inverted', () => {
  it('puts rank 1 at the top and the worst rank at the bottom', () => {
    assert.equal(rankY(1, 14, 40, 430), 40)
    assert.equal(rankY(14, 14, 40, 430), 430)
    assert.ok(rankY(2, 14, 40, 430) < rankY(6, 14, 40, 430))
  })

  it('does not divide by zero when everything shares one rank', () => {
    assert.equal(rankY(1, 1, 40, 430), 40)
  })

  it('puts a lone capture at the right-hand edge, where "now" is', () => {
    assert.equal(captureX(0, 1, 46, 572), 572)
  })
})

// --- movers -----------------------------------------------------------------------

describe('movers are gated on the score, never on the rank alone', () => {
  it('reports nothing at all from the single capture this database has', () => {
    const result = rankMovers([
      series('alan', 'Alan Patekar', [point('2026-07-31', 50.8, 6)]),
      series('mehmet', 'Mehmet Cetin', [point('2026-07-31', 50.8, 6)]),
    ])
    assert.equal(result.climbers.length, 0)
    assert.equal(result.fallers.length, 0)
    assert.equal(result.captures, 1)
    assert.equal(result.tooShort, 2)
  })

  it('names a rank that moved on noise instead of listing it as a climb', () => {
    const result = rankMovers([
      series('mariam', 'Mariam Salama', [
        point('2026-06-30', 49.3, 8),
        point('2026-07-31', 52.7, 4),
      ]),
    ])
    assert.equal(result.climbers.length, 0)
    assert.equal(result.gated.length, 1)
    assert.equal(result.gated[0]!.rankFrom, 8)
    assert.equal(result.gated[0]!.rankTo, 4)
  })

  it('reports a climb only when the score behind it clears the gate', () => {
    const result = rankMovers([
      series('aleksa', 'Aleksa Janjić', [
        point('2026-06-30', 24.4, 14),
        point('2026-07-31', 51.3, 5),
      ]),
    ])
    assert.equal(result.climbers.length, 1)
    assert.equal(result.climbers[0]!.rankChange, 9)
    assert.ok(result.climbers[0]!.scoreChange > MATERIAL_SCORE_GAP)
    assert.equal(result.fallers.length, 0)
  })

  it('puts a redefined subject in neither column and names it', () => {
    const result = rankMovers([
      series('dina', 'Dina Ashraf', [
        point('2026-06-30', 30, 13, V1),
        point('2026-07-31', 57.6, 2, V2),
      ]),
    ])
    assert.equal(result.climbers.length, 0)
    assert.equal(result.fallers.length, 0)
    assert.equal(result.gated.length, 0)
    assert.deepEqual(result.redefined, ['Dina Ashraf'])
  })

  it('shares one rank axis across every mini slope', () => {
    const result = rankMovers([
      series('a', 'A', [point('2026-06-30', 20, 14), point('2026-07-31', 60, 2)]),
      series('b', 'B', [point('2026-06-30', 60, 1), point('2026-07-31', 20, 9)]),
    ])
    assert.equal(result.maxRank, 14)
    assert.equal(result.climbers.length, 1)
    assert.equal(result.fallers.length, 1)
  })

  it('keeps a material move that could not change the rank, instead of losing it', () => {
    // Bottom of the ranking gaining twenty points and still being bottom is the
    // largest real change on the page, and a list built purely on rank drops it.
    const result = rankMovers([
      series('aleksa', 'Aleksa Janjić', [
        point('2026-06-30', 22.1, 14),
        point('2026-07-31', 41.9, 14),
      ]),
    ])
    assert.equal(result.climbers.length, 0)
    assert.equal(result.gated.length, 0)
    assert.equal(result.heldRank.length, 1)
    assert.equal(result.heldRank[0]!.rank, 14)
    assert.ok(result.heldRank[0]!.scoreChange > MATERIAL_SCORE_GAP)
  })

  it('says nothing about a subject that neither moved rank nor moved materially', () => {
    const result = rankMovers([
      series('marko', 'Marko Vrbanec', [
        point('2026-06-30', 52.4, 4),
        point('2026-07-31', 52.7, 4),
      ]),
    ])
    assert.equal(result.heldRank.length, 0)
    assert.equal(result.gated.length, 0)
    assert.equal(result.climbers.length, 0)
  })

  it('counts a subject captured without a rank rather than dropping it silently', () => {
    const result = rankMovers([
      series('security', 'Security', [
        point('2026-06-30', 40, null),
        point('2026-07-31', 70, null),
      ]),
    ])
    assert.equal(result.unranked, 1)
    assert.equal(result.climbers.length, 0)
  })
})

// --- series assembly ----------------------------------------------------------------

describe('series assembly', () => {
  const rows = [
    { id: 'alan', name: 'Alan Patekar', day: '2026-07-31', score: 50.8, rank: 6 },
    { id: 'alan', name: 'Alan Patekar', day: '2026-06-30', score: 48.1, rank: 7 },
    { id: 'mehmet', name: 'Mehmet Cetin', day: '2026-07-31', score: 50.8, rank: 6 },
  ]
  const built = buildSeries(rows, (row) => ({
    id: row.id,
    name: row.name,
    shortName: row.name,
    point: point(row.day, row.score, row.rank),
  }))

  it('groups by subject and sorts each series oldest first', () => {
    assert.equal(built.length, 2)
    const alan = built.find((s) => s.id === 'alan')!
    assert.deepEqual(
      alan.points.map((p) => p.capturedFor),
      ['2026-06-30', '2026-07-31'],
    )
  })

  it('reports the shared x axis as the union of every subject’s capture days', () => {
    assert.deepEqual(captureDays(built), ['2026-06-30', '2026-07-31'])
  })
})
