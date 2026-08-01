import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CONFIDENCE_MARK_MEANING,
  SCORE_CONFIDENCE_MARK,
  confidenceMark,
  confidenceStates,
  isSolidMark,
} from '../src/lib/score-confidence.ts'
import { SCORE_CONFIDENCE_LABEL, type ScoreConfidence } from '../src/lib/types/performance.ts'

const ALL: ScoreConfidence[] = ['high', 'thin', 'no_cohort', 'partial_window']

/**
 * `partial_window` cannot be produced by the live database yet —
 * `0028_tenure_normalisation.sql` is written and unapplied — so every test here is
 * against synthetic rows on purpose. That is the whole reason the mapping is a lib
 * rather than an expression inside five components: the one state nobody can see in
 * production is the one that most needs a test.
 */

describe('the confidence-to-mark map', () => {
  it('covers every state, with no fall-through', () => {
    // The bug this exists to prevent shipped once already: an if-chain on /outliers
    // ended on an `else` that made partial_window read as "no cohort". A Record over
    // the union cannot compile with a state missing.
    for (const c of ALL) {
      assert.ok(SCORE_CONFIDENCE_MARK[c], `${c} has no mark`)
      assert.ok(CONFIDENCE_MARK_MEANING[c], `${c} has no meaning`)
      assert.ok(SCORE_CONFIDENCE_LABEL[c], `${c} has no label`)
    }
    assert.equal(Object.keys(SCORE_CONFIDENCE_MARK).length, ALL.length)
    assert.equal(Object.keys(CONFIDENCE_MARK_MEANING).length, ALL.length)
  })

  it('gives partial_window a mark of its own, not the thin-data one', () => {
    // The finding: "here one week, ranked against a median they did not help set"
    // is a different sentence from "not much data on this person", so it cannot be
    // the same dot.
    assert.equal(SCORE_CONFIDENCE_MARK.partial_window, 'half')
    assert.equal(SCORE_CONFIDENCE_MARK.thin, 'hollow')
    assert.equal(SCORE_CONFIDENCE_MARK.no_cohort, 'hollow')
    assert.equal(SCORE_CONFIDENCE_MARK.high, 'solid')
    assert.notEqual(SCORE_CONFIDENCE_MARK.partial_window, SCORE_CONFIDENCE_MARK.thin)
  })

  it('says the consequence of a part period, not just the cause', () => {
    // "Joined recently" is the cause and is not what a reader needs. The consequence
    // is that they are ranked against a median they are not part of.
    assert.match(CONFIDENCE_MARK_MEANING.partial_window, /ranked/)
    assert.match(CONFIDENCE_MARK_MEANING.partial_window, /not in the cohort median/)
  })

  it('only calls a score solid when it is', () => {
    assert.equal(isSolidMark('high'), true)
    for (const c of ALL.filter((x) => x !== 'high')) assert.equal(isSolidMark(c), false)
  })

  it('treats an unknown confidence as a caveat rather than as clean', () => {
    // A null out of a snapshot row must never draw as a filled dot: an absent flag is
    // not evidence of a good one.
    assert.equal(confidenceMark(null), 'hollow')
    assert.equal(confidenceMark(undefined), 'hollow')
    assert.equal(isSolidMark(null), false)
  })
})

describe('the legend', () => {
  const rows = (...cs: (ScoreConfidence | null)[]) => cs

  it('lists only the states actually on the chart', () => {
    const states = confidenceStates(rows('high', 'high', 'thin'))
    assert.deepEqual(
      states.map((s) => s.confidence),
      ['high', 'thin'],
    )
    assert.deepEqual(
      states.map((s) => s.count),
      [2, 1],
    )
    // A legend row for a state nobody is in teaches the reader to ignore the legend.
    assert.ok(!states.some((s) => s.confidence === 'partial_window'))
  })

  it('surfaces a part-period engineer the moment one appears', () => {
    const states = confidenceStates(rows('high', 'partial_window', 'no_cohort'))
    assert.deepEqual(
      states.map((s) => s.confidence),
      ['high', 'no_cohort', 'partial_window'],
    )
    const partial = states.find((s) => s.confidence === 'partial_window')!
    assert.equal(partial.label, 'part period')
    assert.equal(partial.mark, 'half')
  })

  it('keeps the clean state first and the caveats after it, whatever the row order', () => {
    const forwards = confidenceStates(rows('partial_window', 'no_cohort', 'thin', 'high'))
    const backwards = confidenceStates(rows('high', 'thin', 'no_cohort', 'partial_window'))
    assert.deepEqual(
      forwards.map((s) => s.confidence),
      backwards.map((s) => s.confidence),
    )
    assert.equal(forwards[0]!.confidence, 'high')
  })

  it('takes its wording from the shared label map rather than restating it', () => {
    for (const state of confidenceStates(rows(...ALL))) {
      assert.equal(state.label, SCORE_CONFIDENCE_LABEL[state.confidence].label)
    }
  })

  it('drops rows with no flag rather than inventing a state for them', () => {
    assert.deepEqual(confidenceStates(rows(null, null)), [])
    // A null beside a thin flag leaves one state, not two: the null is not a state.
    assert.deepEqual(
      confidenceStates(rows('thin', null)).map((s) => s.count),
      [1],
    )
  })

  it('is empty for an empty chart', () => {
    assert.deepEqual(confidenceStates([]), [])
  })

  it('says nothing when every mark on the chart is the same solid one', () => {
    // A one-row legend reading "solid (13)" distinguishes nothing and is furniture.
    assert.deepEqual(confidenceStates(rows('high', 'high', 'high')), [])
  })

  it('still speaks up when every mark is the same caveated one', () => {
    // "Every score here rests on thin data" needs saying whether or not there is a
    // solid mark on the chart to contrast it against.
    const states = confidenceStates(rows('thin', 'thin'))
    assert.deepEqual(
      states.map((s) => s.confidence),
      ['thin'],
    )
    assert.equal(confidenceStates(rows('partial_window')).length, 1)
  })
})
