import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  captureDates,
  comparablePair,
  computeMovers,
  crossesDefinitionBoundary,
  segmentByDefinition,
  sortByDate,
  toRankSeries,
  type EngineerScoreSnapshot,
  type ScoreSnapshot,
} from '../src/lib/score-history.ts'

/**
 * The rule these tests exist to pin: **a line may only connect two scores computed
 * the same way.** `0025_score_snapshots.sql` stamps every capture with the
 * `definition_version` that produced it precisely so this is checkable, and two
 * scoring migrations have already changed every score in the table without anyone's
 * work changing — 0023 (complexity-weighted throughput) and 0029 (per-week rates).
 *
 * A bug here does not look like a bug. It looks like a tidy chart showing a trend
 * that is really two different questions answered once each, which is the most
 * expensive kind of wrong this app can be.
 */

function snap(
  capturedFor: string,
  version: string,
  score: number | null,
  rank: number | null = null,
): ScoreSnapshot {
  return {
    captured_for: capturedFor,
    definition_version: version,
    score,
    rank_in_org: rank,
    rank_at_level: null,
    peers_at_level: null,
    throughput_score: null,
    flow_score: null,
    quality_score: null,
    collaboration_score: null,
    score_confidence: 'high',
    standing: null,
  }
}

function eng(
  engineerId: string,
  name: string,
  capturedFor: string,
  version: string,
  score: number | null,
  rank: number | null,
): EngineerScoreSnapshot {
  return {
    ...snap(capturedFor, version, score, rank),
    engineer_id: engineerId,
    full_name: name,
    seniority_key: 'senior',
  }
}

describe('sortByDate', () => {
  it('puts captures oldest first regardless of the order they arrived in', () => {
    const sorted = sortByDate([
      snap('2026-08-03', 'v1', 50),
      snap('2026-08-01', 'v1', 48),
      snap('2026-08-02', 'v1', 49),
    ])
    assert.deepEqual(
      sorted.map((s) => s.captured_for),
      ['2026-08-01', '2026-08-02', '2026-08-03'],
    )
  })

  it('does not mutate its input', () => {
    const input = [snap('2026-08-03', 'v1', 50), snap('2026-08-01', 'v1', 48)]
    sortByDate(input)
    assert.equal(input[0].captured_for, '2026-08-03')
  })
})

describe('segmentByDefinition', () => {
  it('keeps one run of one version as a single segment', () => {
    const segments = segmentByDefinition([
      snap('2026-08-01', 'v1', 48),
      snap('2026-08-02', 'v1', 49),
      snap('2026-08-03', 'v1', 50),
    ])
    assert.equal(segments.length, 1)
    assert.equal(segments[0].points.length, 3)
  })

  it('splits where the definition changes, so no line spans the boundary', () => {
    const segments = segmentByDefinition([
      snap('2026-08-01', '0024-authored-churn', 48),
      snap('2026-08-02', '0024-authored-churn', 49),
      snap('2026-08-03', '0029-tenure-rates', 22),
      snap('2026-08-04', '0029-tenure-rates', 23),
    ])
    assert.equal(segments.length, 2)
    assert.deepEqual(
      segments.map((s) => s.points.length),
      [2, 2],
    )
    assert.equal(segments[0].definitionVersion, '0024-authored-churn')
    assert.equal(segments[1].definitionVersion, '0029-tenure-rates')
  })

  it('segments on chronological order, not arrival order', () => {
    // Same data as above, shuffled. A naive implementation that trusted input order
    // would produce four segments and draw nothing at all.
    const segments = segmentByDefinition([
      snap('2026-08-03', '0029-tenure-rates', 22),
      snap('2026-08-01', '0024-authored-churn', 48),
      snap('2026-08-04', '0029-tenure-rates', 23),
      snap('2026-08-02', '0024-authored-churn', 49),
    ])
    assert.equal(segments.length, 2)
    assert.deepEqual(
      segments.map((s) => s.points.length),
      [2, 2],
    )
  })

  it('starts a new segment when a version reappears after another', () => {
    // A rollback is still a boundary in both directions: v1 -> v2 -> v1 is three
    // runs, not two, because the middle reading is not comparable with either side.
    const segments = segmentByDefinition([
      snap('2026-08-01', 'v1', 48),
      snap('2026-08-02', 'v2', 30),
      snap('2026-08-03', 'v1', 49),
    ])
    assert.equal(segments.length, 3)
  })

  it('returns nothing for no captures', () => {
    assert.deepEqual(segmentByDefinition([]), [])
  })
})

describe('comparablePair', () => {
  it('pairs the two most recent captures when they share a definition', () => {
    const pair = comparablePair([snap('2026-08-01', 'v1', 48), snap('2026-08-02', 'v1', 51)])
    assert.ok(pair)
    assert.equal(pair.previous.score, 48)
    assert.equal(pair.latest.score, 51)
  })

  it('refuses to pair across a definition change', () => {
    // This is the important negative: the two captures exist, they are adjacent, and
    // comparing them would produce a confident-looking delta that means nothing.
    const pair = comparablePair([
      snap('2026-08-01', '0024-authored-churn', 48),
      snap('2026-08-02', '0029-tenure-rates', 22),
    ])
    assert.equal(pair, null)
  })

  it('refuses to pair a single capture', () => {
    assert.equal(comparablePair([snap('2026-08-01', 'v1', 48)]), null)
    assert.equal(comparablePair([]), null)
  })

  it('looks only at the latest pair, not any older comparable one', () => {
    const pair = comparablePair([
      snap('2026-08-01', 'v1', 40),
      snap('2026-08-02', 'v1', 41),
      snap('2026-08-03', 'v2', 60),
    ])
    assert.equal(pair, null, 'the most recent capture has no comparable predecessor')
  })
})

describe('crossesDefinitionBoundary', () => {
  it('is false for one version and for no data', () => {
    assert.equal(crossesDefinitionBoundary([snap('2026-08-01', 'v1', 1)]), false)
    assert.equal(crossesDefinitionBoundary([]), false)
  })

  it('is true as soon as two versions are present', () => {
    assert.equal(
      crossesDefinitionBoundary([snap('2026-08-01', 'v1', 1), snap('2026-08-02', 'v2', 1)]),
      true,
    )
  })
})

describe('computeMovers', () => {
  it('reports a score delta and flips rank direction to how a person would say it', () => {
    const movers = computeMovers([
      eng('a', 'Ada Lovelace', '2026-08-01', 'v1', 44.0, 8),
      eng('a', 'Ada Lovelace', '2026-08-02', 'v1', 51.5, 3),
    ])
    assert.equal(movers.length, 1)
    assert.equal(movers[0].scoreDelta, 7.5)
    // Rank 8 -> 3 is an improvement of five, not minus five.
    assert.equal(movers[0].rankDelta, 5)
    assert.equal(movers[0].rankFrom, 8)
    assert.equal(movers[0].rankTo, 3)
  })

  it('reports a decline as negative', () => {
    const movers = computeMovers([
      eng('a', 'Ada', '2026-08-01', 'v1', 60, 2),
      eng('a', 'Ada', '2026-08-02', 'v1', 55, 6),
    ])
    assert.equal(movers[0].scoreDelta, -5)
    assert.equal(movers[0].rankDelta, -4)
  })

  it('drops an engineer whose latest capture crosses a definition boundary', () => {
    const movers = computeMovers([
      eng('a', 'Ada', '2026-08-01', '0024-authored-churn', 44, 8),
      eng('a', 'Ada', '2026-08-02', '0029-tenure-rates', 22, 12),
    ])
    assert.deepEqual(movers, [])
  })

  it('decides comparability per engineer, not once for the whole org', () => {
    // Ada has a comparable pair; Grace joined and has only one capture. Grace must
    // not cost Ada her row.
    const movers = computeMovers([
      eng('a', 'Ada', '2026-08-01', 'v1', 44, 2),
      eng('a', 'Ada', '2026-08-02', 'v1', 46, 1),
      eng('g', 'Grace', '2026-08-02', 'v1', 30, 9),
    ])
    assert.equal(movers.length, 1)
    assert.equal(movers[0].fullName, 'Ada')
  })

  it('does not treat a missing score as a zero', () => {
    const movers = computeMovers([
      eng('a', 'Ada', '2026-08-01', 'v1', null, 5),
      eng('a', 'Ada', '2026-08-02', 'v1', 48, 4),
    ])
    assert.equal(movers.length, 1)
    assert.equal(movers[0].scoreDelta, null, 'null in, null out — not a 48-point rise')
    assert.equal(movers[0].rankDelta, 1)
  })

  it('orders by the size of the move, not its direction', () => {
    const movers = computeMovers([
      eng('a', 'Ada', '2026-08-01', 'v1', 50, 1),
      eng('a', 'Ada', '2026-08-02', 'v1', 52, 1),
      eng('g', 'Grace', '2026-08-01', 'v1', 50, 2),
      eng('g', 'Grace', '2026-08-02', 'v1', 38, 7),
    ])
    assert.deepEqual(
      movers.map((m) => m.fullName),
      ['Grace', 'Ada'],
      'a 12-point fall outranks a 2-point rise',
    )
  })
})

describe('toRankSeries', () => {
  it('groups by engineer and orders best current rank first', () => {
    const series = toRankSeries([
      eng('a', 'Ada', '2026-08-01', 'v1', 40, 5),
      eng('a', 'Ada', '2026-08-02', 'v1', 44, 4),
      eng('g', 'Grace', '2026-08-01', 'v1', 60, 2),
      eng('g', 'Grace', '2026-08-02', 'v1', 62, 1),
    ])
    assert.deepEqual(
      series.map((s) => s.fullName),
      ['Grace', 'Ada'],
    )
    assert.deepEqual(
      series[0].points.map((p) => p.rank),
      [2, 1],
      'points stay chronological within a series',
    )
  })

  it('skips captures with no rank but keeps the engineer', () => {
    const series = toRankSeries([
      eng('a', 'Ada', '2026-08-01', 'v1', 40, null),
      eng('a', 'Ada', '2026-08-02', 'v1', 44, 3),
    ])
    assert.equal(series.length, 1)
    assert.equal(series[0].points.length, 1)
  })

  it('keeps a single-point series, because one reading is not no reading', () => {
    const series = toRankSeries([eng('a', 'Ada', '2026-08-01', 'v1', 40, 3)])
    assert.equal(series.length, 1)
    assert.equal(series[0].points.length, 1)
  })
})

describe('captureDates', () => {
  it('dedupes and orders the x axis', () => {
    assert.deepEqual(
      captureDates([
        { captured_for: '2026-08-02' },
        { captured_for: '2026-08-01' },
        { captured_for: '2026-08-02' },
      ]),
      ['2026-08-01', '2026-08-02'],
    )
  })
})
