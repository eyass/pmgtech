import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scoreTone } from '../src/lib/types/performance.ts'

/**
 * The score's own arithmetic lives in SQL (`0021_outliers.sql`) and is exercised
 * against the database. What is testable here is how a score is coloured, and
 * that is worth pinning: 50 means "at the median for your level", so a green or
 * amber pill at 50 would turn a neutral fact into a verdict on a page whose whole
 * risk is being read as one.
 */
describe('scoreTone', () => {
  it('leaves the middle of the range neutral', () => {
    for (const score of [45, 48, 50, 52, 57.3, 64.9]) {
      assert.equal(scoreTone(score), 'neutral', `${score} should read neutral`)
    }
  })

  it('calls out genuinely high and genuinely low scores', () => {
    assert.equal(scoreTone(65), 'good')
    assert.equal(scoreTone(98.3), 'good')
    assert.equal(scoreTone(44.9), 'warn')
    assert.equal(scoreTone(35), 'warn')
    assert.equal(scoreTone(34.9), 'bad')
    assert.equal(scoreTone(18.5), 'bad')
  })

  it('has no tone for a missing score, so a withheld dimension is not a bad one', () => {
    assert.equal(scoreTone(null), 'neutral')
    assert.equal(scoreTone(undefined), 'neutral')
  })
})
