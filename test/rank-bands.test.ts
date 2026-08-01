import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MATERIAL_SCORE_GAP,
  beeswarmLanes,
  levelSlot,
  materiallyApart,
  tieBands,
  tieSummary,
} from '../src/lib/rank-bands.ts'

/**
 * The real shape of this org over the trailing 90 days, read out of
 * `engineer_outliers(now() - interval '90 days', now())`. Fourteen scored engineers,
 * eleven of them inside 6.6 points — this is the data the tie band exists for.
 */
const REAL_SCORES: { id: string; score: number | null }[] = [
  { id: 'aleksandra', score: 69.8 },
  { id: 'dina-ashraf', score: 57.6 },
  { id: 'dina-fejzovic', score: 53.5 },
  { id: 'marko', score: 52.7 },
  { id: 'nikola', score: 51.3 },
  { id: 'alan', score: 50.8 },
  { id: 'mehmet', score: 50.8 },
  { id: 'mariam', score: 49.3 },
  { id: 'jacek', score: 49.2 },
  { id: 'christopher', score: 48.6 },
  { id: 'mary', score: 47.6 },
  { id: 'ugljesa', score: 47.3 },
  { id: 'irina', score: 46.9 },
  { id: 'aleksa', score: 24.4 },
]

// --- the tie band rule -------------------------------------------------------

test('the materiality gate is one interquartile range, which the score makes 15 points', () => {
  // Not a number picked for this chart: score_vs_cohort in 0021 puts ±1 IQR at ±15
  // points around 50. Changing this constant means changing what the app means by a
  // material difference, so it gets an explicit test rather than being implicit.
  assert.equal(MATERIAL_SCORE_GAP, 15)

  assert.equal(materiallyApart(50, 65), true, '15 points clears the gate, as 0018 uses >=')
  assert.equal(materiallyApart(50, 64.9), false)
  assert.equal(materiallyApart(65, 50), true, 'direction must not matter')
})

test('the real org falls into three groups, not fourteen ranks', () => {
  const bands = tieBands(REAL_SCORES)

  assert.equal(bands.length, 3)
  assert.deepEqual(
    bands.map((b) => b.ids.length),
    [2, 11, 1],
  )
  // The finding the chart is for: eleven engineers the table numbers 3 to 13 sit
  // inside 6.6 points, well under half an interquartile range.
  assert.equal(Number((bands[1]!.top - bands[1]!.bottom).toFixed(1)), 6.6)
  assert.ok(bands[1]!.ids.includes('dina-fejzovic'))
  assert.ok(bands[1]!.ids.includes('irina'))
  // The thin-data engineer at 24.4 is the one genuine separation on the chart.
  assert.deepEqual(bands[2]!.ids, ['aleksa'])
})

test('every pair inside a band is within one interquartile range of every other', () => {
  // This is the property that makes a band a claim rather than a chain: single
  // linkage on consecutive gaps would have swept 69.8 down to 46.9 into one group,
  // 22.9 points, and called a genuine one-and-a-half-IQR difference a tie.
  const scores = new Map(REAL_SCORES.map((r) => [r.id, r.score!]))
  for (const band of tieBands(REAL_SCORES)) {
    for (const a of band.ids) {
      for (const b of band.ids) {
        assert.ok(
          !materiallyApart(scores.get(a)!, scores.get(b)!),
          `${a} and ${b} share a band but are materially apart`,
        )
      }
    }
  }
})

test('bands are contiguous runs of the score order, so they can be drawn as one box', () => {
  const ordered = [...REAL_SCORES]
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score! - a.score!)
    .map((r) => r.id)

  let cursor = 0
  for (const band of tieBands(REAL_SCORES)) {
    assert.deepEqual(band.ids, ordered.slice(cursor, cursor + band.ids.length))
    cursor += band.ids.length
  }
  assert.equal(cursor, ordered.length)
})

test('a chain of small steps is split rather than swept into one tie', () => {
  // 100, 90, 80, 70, 60: every consecutive gap is 10 and under the gate, but the ends
  // are 40 apart. Greedy-from-the-top must break it; chaining must not be reachable.
  const bands = tieBands([
    { id: 'a', score: 100 },
    { id: 'b', score: 90 },
    { id: 'c', score: 80 },
    { id: 'd', score: 70 },
    { id: 'e', score: 60 },
  ])
  assert.deepEqual(
    bands.map((b) => b.ids),
    [['a', 'b'], ['c', 'd'], ['e']],
  )
})

test('unscored engineers are dropped, not banded at zero', () => {
  const bands = tieBands([
    { id: 'a', score: 60 },
    { id: 'b', score: null },
    { id: 'c', score: 55 },
  ])
  assert.deepEqual(bands.map((b) => b.ids), [['a', 'c']])
})

test('an identical score is always one band, and an empty list is no bands', () => {
  assert.deepEqual(tieBands([]).length, 0)
  assert.deepEqual(
    tieBands([
      { id: 'a', score: 50 },
      { id: 'b', score: 50 },
      { id: 'c', score: 50 },
    ]).map((b) => b.ids),
    [['a', 'b', 'c']],
  )
})

test('banding does not depend on the order rows arrive in', () => {
  const shuffled = [...REAL_SCORES].reverse()
  assert.deepEqual(
    tieBands(shuffled).map((b) => b.ids.slice().sort()),
    tieBands(REAL_SCORES).map((b) => b.ids.slice().sort()),
  )
})

// --- the header finding ------------------------------------------------------

test('the finding the page leads with is counted, never written down', () => {
  const summary = tieSummary(REAL_SCORES)
  assert.equal(summary.scored, 14)
  assert.equal(summary.bands, 3)
  // Two in the top band and eleven in the middle: thirteen of fourteen.
  assert.equal(summary.tied, 13)
  assert.equal(summary.sentence, '13 of 14 hold a rank number that is not a difference')
})

test('the finding degrades sensibly at every small N', () => {
  const rows = (...scores: (number | null)[]) =>
    scores.map((score, i) => ({ id: `e${i}`, score }))

  // Nobody scored: "0 of 0" is not a finding, so there is nothing to say.
  assert.equal(tieSummary([]).sentence, null)
  assert.equal(tieSummary(rows(null, null)).sentence, null)

  // One engineer: there is no ranking, so no rank number can be noise. Saying
  // "0 of 1 hold a rank number that is not a difference" implies the opposite.
  assert.equal(tieSummary(rows(60)).sentence, 'one scored engineer, so there is no ranking to separate')

  // Two, materially apart: the positive claim, said positively.
  assert.equal(
    tieSummary(rows(80, 60)).sentence,
    'every rank number here clears a full interquartile range',
  )

  // Two, not apart: everybody is tied, and "2 of 2" is arithmetic nobody should do.
  assert.equal(
    tieSummary(rows(60, 55)).sentence,
    'no rank number here is a difference — all 2 sit inside a tie band',
  )

  // Everybody tied across more than one band still counts as everybody tied: each of
  // them shares a band with somebody, so not one of their rank numbers is a claim.
  assert.equal(
    tieSummary(rows(100, 95, 60, 55)).sentence,
    'no rank number here is a difference — all 4 sit inside a tie band',
  )

  // The mixed case, which is the one the real org is in.
  assert.equal(
    tieSummary(rows(100, 95, 60)).sentence,
    '2 of 3 hold a rank number that is not a difference',
  )
})

test('the summary counts the same bands the chart draws', () => {
  // Header and legend read one function precisely so they cannot disagree; this is
  // the property that makes that safe.
  const bands = tieBands(REAL_SCORES)
  const summary = tieSummary(REAL_SCORES)
  assert.equal(summary.bands, bands.length)
  assert.equal(
    summary.tied,
    bands.filter((b) => b.ids.length > 1).reduce((n, b) => n + b.ids.length, 0),
  )
  assert.equal(summary.scored, bands.reduce((n, b) => n + b.ids.length, 0))
})

// --- beeswarm offsets --------------------------------------------------------

test('beeswarm lanes are deterministic and free of randomness', () => {
  const points = [
    { id: 'a', position: 100 },
    { id: 'b', position: 104 },
    { id: 'c', position: 108 },
    { id: 'd', position: 140 },
  ]
  const first = beeswarmLanes(points, 12)
  for (let i = 0; i < 25; i += 1) {
    assert.deepEqual([...beeswarmLanes(points, 12)], [...first])
  }
})

test('beeswarm lanes survive a permuted input unchanged', () => {
  // A chart that reshuffles between two renders of the same data cannot be compared
  // against itself, and row order out of Postgres is not a contract.
  const points = [
    { id: 'a', position: 100 },
    { id: 'b', position: 104 },
    { id: 'c', position: 108 },
    { id: 'd', position: 140 },
    { id: 'e', position: 142 },
  ]
  const expected = beeswarmLanes(points, 12)
  const rotations = [1, 2, 3, 4].map((n) => [...points.slice(n), ...points.slice(0, n)])
  for (const rotated of [...rotations, [...points].reverse()]) {
    assert.deepEqual(
      [...beeswarmLanes(rotated, 12)].sort(),
      [...expected].sort(),
      'lane assignment must not depend on input order',
    )
  }
})

test('lanes go centre-out, and only where dots actually collide', () => {
  const lanes = beeswarmLanes(
    [
      { id: 'a', position: 0 },
      { id: 'b', position: 0 },
      { id: 'c', position: 0 },
      { id: 'd', position: 0 },
      { id: 'far', position: 500 },
    ],
    12,
  )
  assert.deepEqual([lanes.get('a'), lanes.get('b'), lanes.get('c'), lanes.get('d')], [0, 1, -1, 2])
  assert.equal(lanes.get('far'), 0, 'a dot with room stays on the line')
})

test('no two dots in one lane end up closer than the minimum gap', () => {
  // The whole contract: after offsetting, the picture is countable.
  const points = Array.from({ length: 60 }, (_, i) => ({
    id: `e${i}`,
    // Deliberately clumped, the way one interquartile range of a real cohort is.
    position: 200 + (i % 7) * 4 + Math.floor(i / 7),
  }))
  const lanes = beeswarmLanes(points, 12)
  const byLane = new Map<number, number[]>()
  for (const p of points) {
    const lane = lanes.get(p.id)!
    byLane.set(lane, [...(byLane.get(lane) ?? []), p.position])
  }
  for (const [lane, positions] of byLane) {
    const sorted = [...positions].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(sorted[i]! - sorted[i - 1]! >= 12, `lane ${lane} has an overlap`)
    }
  }
})

// --- rank at level on a shared column ----------------------------------------

test('a level rank is stretched to its own cohort, so the ends mean the same thing', () => {
  // The bug this prevents: last of five mids drawn above sixth of nine seniors.
  assert.equal(levelSlot(5, 5, 14), 14, 'last at level is the bottom of the column')
  assert.equal(levelSlot(9, 9, 14), 14)
  assert.equal(levelSlot(1, 5, 14), 1, 'best at level is the top of the column')
  assert.equal(levelSlot(1, 9, 14), 1)
  // A mid-cohort placing lands proportionally, not at its raw number.
  assert.equal(levelSlot(3, 5, 14), 7.5)
  assert.equal(levelSlot(5, 9, 14), 7.5)
})

test('a cohort of one has no placing to draw', () => {
  assert.equal(levelSlot(1, 1, 14), null)
  assert.equal(levelSlot(1, 0, 14), null)
})

test('a rank outside its cohort is clamped rather than drawn off the column', () => {
  assert.equal(levelSlot(20, 5, 14), 14)
  assert.equal(levelSlot(0, 5, 14), 1)
})
