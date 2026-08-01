import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MATERIAL_DIMENSION_DISTANCE,
  SHARE_FLOOR,
  driverTally,
  scoreDrivers,
} from '../src/lib/score-drivers.ts'
import { MATERIAL_SCORE_GAP } from '../src/lib/rank-bands.ts'
import { type RadarValues } from '../src/lib/radar-geometry.ts'

/**
 * Driver attribution has exactly two ways to be dishonest, and both are cheap to
 * make: name a driver that is not one, and let a withheld dimension read as a weak
 * one. Everything here is pointed at those two.
 */

const v = (
  throughput: number | null,
  flow: number | null,
  quality: number | null,
  collaboration: number | null,
): RadarValues => ({ throughput, flow, quality, collaboration })

/**
 * The real org over the trailing 90 days, out of
 * `engineer_outliers(now() - interval '90 days', now())`. Twelve scored engineers.
 * Half of them have a dimension a full interquartile range from the median and half
 * do not, which is the split the gate has to reproduce.
 */
const REAL = {
  aleksandra: v(63.3, 98, 49.0, 67.0), // composite 69.3, flow miles out
  dinaAshraf: v(69.7, 74, 44.0, 46.7), // composite 58.6, two material dimensions
  dinaFejzovic: v(54.7, 53, 44.5, 66.7), // composite 54.7, collaboration only
  marko: v(50.0, 50, 50.0, 57.3), // composite 51.8, nothing
  mehmet: v(37.7, 57, 53.8, 53.3), // composite 50.5, nothing (throughput -12.3)
  nikola: v(50.0, 45, 45.8, 61.3), // composite 50.5, nothing (collab +11.3)
  mariam: v(69.7, 41, 40.3, 46.7), // composite 49.4, throughput up while the score is down
  jacek: v(46.0, 50, 51.3, 47.0), // composite 48.6, nothing
  mary: v(47.0, 53, 43.5, 46.7), // composite 47.6, nothing
  christopher: v(50.3, 46, 48.0, 45.0), // composite 47.3, nothing
  irina: v(39.7, 44, 58.8, 34.0), // composite 44.1, collaboration down
  aleksa: v(14.7, 0, 57.3, 24.0), // composite 24.0, the one real separation
}

// --- the gate ----------------------------------------------------------------

describe('the materiality gate', () => {
  it('is the same one interquartile range the rest of the page uses', () => {
    // Deliberately not a second threshold. The reasoning — that a dimension k points
    // from 50 only moves the composite k/n, so anything under a full IQR is
    // attributing a placing to sub-material movement — is in the module comment.
    // Pinned here so lowering it is a decision somebody makes on purpose.
    assert.equal(MATERIAL_DIMENSION_DISTANCE, MATERIAL_SCORE_GAP)
    assert.equal(MATERIAL_DIMENSION_DISTANCE, 15)
  })

  it('names a driver at exactly one interquartile range and not a tenth under it', () => {
    assert.equal(scoreDrivers(v(65, 50, 50, 50)).driver?.dimension, 'throughput')
    assert.equal(scoreDrivers(v(64.9, 50, 50, 50)).driver, null)
    assert.equal(scoreDrivers(v(35, 50, 50, 50)).driver?.dimension, 'throughput')
    assert.equal(scoreDrivers(v(35.1, 50, 50, 50)).driver, null)
  })

  it('refuses to manufacture a driver out of a small lead', () => {
    // Marko is 4th in the org. Nothing about him is a full range from the median, so
    // the honest answer is that nothing separates him — not "collaboration".
    const marko = scoreDrivers(REAL.marko)
    assert.equal(marko.verdict, 'even')
    assert.equal(marko.driver, null)
    assert.equal(marko.headline, null)
    assert.match(marko.sentence, /Nothing separates this engineer/)
    // The widest is still named, and named as not a difference, so a reader who goes
    // looking for it on the beeswarm has already been told what it is worth.
    assert.match(marko.sentence, /collaboration at 7\.3 above, is not a difference/)
  })

  it('leaves most of this org with no driver at all, which is the finding', () => {
    const tally = driverTally(Object.values(REAL).map((values) => ({ values })))
    assert.deepEqual(tally, { driven: 6, even: 6, unscored: 0, total: 12 })
  })
})

// --- the decomposition -------------------------------------------------------

describe('the decomposition', () => {
  it('reproduces the composite the SQL publishes', () => {
    // 0021 computes an equally weighted mean over the non-null dimensions. If this
    // drifts, every contribution below it is attributing shares of a number that is
    // not the one printed on the row.
    const expected: [RadarValues, number][] = [
      [REAL.aleksandra, 69.3],
      [REAL.dinaAshraf, 58.6],
      [REAL.marko, 51.8],
      [REAL.irina, 44.1],
      [REAL.aleksa, 24.0],
    ]
    for (const [values, composite] of expected) {
      assert.equal(Number(scoreDrivers(values).composite!.toFixed(1)), composite)
    }
  })

  it('contributions sum exactly to the distance from the median, with no residual', () => {
    for (const values of Object.values(REAL)) {
      const d = scoreDrivers(values)
      const sum = d.terms.reduce((t, term) => t + term.contribution, 0)
      assert.ok(
        Math.abs(sum - d.distance!) < 1e-9,
        `contributions sum to ${sum}, distance is ${d.distance}`,
      )
    }
  })

  it('shares sum to one when every dimension is counted', () => {
    for (const values of Object.values(REAL)) {
      const d = scoreDrivers(values)
      if (d.terms.some((t) => t.share === null)) continue
      const sum = d.terms.reduce((t, term) => t + term.share!, 0)
      assert.ok(Math.abs(sum - 1) < 1e-9, `shares sum to ${sum}`)
    }
  })

  it('attributes Aleksandra almost entirely to flow', () => {
    const d = scoreDrivers(REAL.aleksandra)
    assert.equal(d.verdict, 'driven')
    assert.equal(d.driver!.dimension, 'flow')
    assert.equal(d.driver!.deviation, 48)
    // 48 / 4 dimensions = 12.0 of the 19.325 she sits above the median.
    assert.equal(Number(d.driver!.contribution.toFixed(2)), 12)
    assert.equal(Math.round(d.driver!.share! * 100), 62)
    // Collaboration also clears the gate; quality does not and must not be named.
    assert.deepEqual(
      d.alsoMaterial.map((t) => t.dimension),
      ['collaboration'],
    )
    assert.equal(d.headline, 'flow +48')
  })

  it('never says a dimension accounts for a placing it points away from', () => {
    // The backwards sentence this prevents: throughput 30 above the median on a
    // composite that lands below it. "Throughput accounts for -300% of the distance"
    // is arithmetic, not a sentence.
    const d = scoreDrivers(v(80, 30, 40, 40))
    assert.equal(d.driver!.dimension, 'throughput')
    assert.ok(d.distance! < 0)
    assert.ok(d.driver!.share! < 0)
    assert.ok(!/%/.test(d.sentence), d.sentence)
    assert.match(d.sentence, /the other dimensions more than cancel it/)
  })

  it('says so when a dimension more than accounts for the distance', () => {
    // Throughput 20 above, flow 8 below: the composite is only 3 above the median,
    // so throughput's +5.0 is more than the whole of it.
    const d = scoreDrivers(v(70, 42, 50, 50))
    assert.equal(d.distance, 3)
    assert.ok(d.driver!.share! > 1)
    assert.match(d.sentence, /more than the whole of it, with the rest pulling back/)
  })

  it('refuses to share out a distance the composite does not have', () => {
    // Mariam is the real case: throughput 19.7 above the median while the composite
    // lands 0.6 *below* it. The share would be -857%, which the floor withholds.
    const d = scoreDrivers(REAL.mariam)
    assert.equal(d.driver!.dimension, 'throughput')
    assert.ok(Math.abs(d.distance!) < 1)
    assert.equal(d.driver!.share, null)
    assert.match(d.sentence, /Throughput is 19\.7 above the cohort median, worth \+4\.9/)
    assert.match(d.sentence, /sits within a point of the median, so there is no distance to share out/)
  })

  it('orders terms by distance from the median, breaking ties on the fixed axis order', () => {
    const d = scoreDrivers(v(60, 40, 60, 50))
    assert.deepEqual(
      d.terms.map((t) => t.dimension),
      ['throughput', 'flow', 'quality', 'collaboration'],
    )
  })
})

// --- a null dimension is withheld, not weak ----------------------------------

describe('a withheld dimension', () => {
  it('drops out of the mean rather than counting as zero', () => {
    // The whole point of the renormalisation in 0021. 60 and 60 with two nulls is a
    // composite of 60, not of 30.
    const d = scoreDrivers(v(60, 60, null, null))
    assert.equal(d.composite, 60)
    assert.equal(d.terms.length, 2)
    // With two dimensions the divisor is two, so each is worth half its own distance.
    assert.equal(d.terms[0]!.contribution, 5)
  })

  it('is never a driver and never counts against anybody', () => {
    const d = scoreDrivers(v(50, 50, null, 50))
    assert.equal(d.verdict, 'even')
    assert.equal(d.driver, null)
    assert.deepEqual(
      d.withheld.map((w) => w.dimension),
      ['quality'],
    )
    assert.ok(!d.terms.some((t) => t.dimension === 'quality'))
  })

  it('is said out loud, so a reader does not read the gap as a low score', () => {
    assert.match(
      scoreDrivers(v(50, 50, null, 50)).sentence,
      /Quality is withheld rather than low — no data behind it, so the composite is the mean of the other 3\./,
    )
    assert.match(
      scoreDrivers(v(50, null, null, 50)).sentence,
      /Flow and quality are withheld rather than low — no data behind them, so the composite is the mean of the other 2\./,
    )
  })

  it('with nothing measured at all reports unscored, not a composite of nothing', () => {
    const d = scoreDrivers(v(null, null, null, null))
    assert.equal(d.verdict, 'unscored')
    assert.equal(d.composite, null)
    assert.equal(d.distance, null)
    assert.equal(d.headline, null)
    assert.deepEqual(d.terms, [])
    assert.equal(d.withheld.length, 4)
    assert.match(d.sentence, /No dimension had any data behind it/)
  })

  it('treats a non-finite sub-score as absent rather than plotting it', () => {
    const d = scoreDrivers({
      throughput: Number.NaN,
      flow: 80,
      quality: 50,
      collaboration: 50,
    })
    assert.equal(d.terms.length, 3)
    assert.deepEqual(
      d.withheld.map((w) => w.dimension),
      ['throughput'],
    )
  })
})

// --- percentages of nothing ---------------------------------------------------

describe('the share', () => {
  it('is withheld inside a point of the median, where its denominator is rounding', () => {
    assert.equal(SHARE_FLOOR, 1)
    // 51.9 / 48.1 / 50 / 50 is a composite of exactly 50: the two dimensions cancel.
    // A share would be a division by zero dressed up as a finding.
    const cancelled = scoreDrivers(v(51.9, 48.1, 50, 50))
    assert.equal(cancelled.distance, 0)
    assert.ok(cancelled.terms.every((t) => t.share === null))
    // The contributions are still exact, so the row is not left saying nothing.
    assert.equal(Number(cancelled.terms[0]!.contribution.toFixed(4)), 0.475)
  })

  it('is reported once the composite is a point clear of the median', () => {
    const d = scoreDrivers(v(54, 54, 54, 54))
    assert.equal(d.distance, 4)
    assert.ok(d.terms.every((t) => t.share !== null))
  })

  it('does not appear in a sentence it would be meaningless in', () => {
    // A driver right on the floor: 65/35/50/50 is a composite of 50 with two
    // dimensions a full range out in opposite directions.
    const d = scoreDrivers(v(65, 35, 50, 50))
    assert.equal(d.verdict, 'driven')
    assert.equal(d.driver!.share, null)
    assert.ok(!/%/.test(d.sentence), `share leaked into: ${d.sentence}`)
    assert.match(d.sentence, /worth \+3\.8 of the composite — which sits within a point/)
    // The second material dimension is still named, and named as a sentence.
    assert.match(d.sentence, /Flow 15\.0 below also clears the gate\./)
  })

  it('never prints a negative zero', () => {
    const d = scoreDrivers(v(35, 65, 50, 50))
    assert.ok(!d.sentence.includes('-0.0'), d.sentence)
  })
})

// --- the org tally ------------------------------------------------------------

describe('the org tally', () => {
  it('counts every row exactly once across the three verdicts', () => {
    const rows = [...Object.values(REAL), v(null, null, null, null)].map((values) => ({ values }))
    const tally = driverTally(rows)
    assert.equal(tally.driven + tally.even + tally.unscored, tally.total)
    assert.equal(tally.total, 13)
    assert.equal(tally.unscored, 1)
  })

  it('is empty for an empty org rather than throwing', () => {
    assert.deepEqual(driverTally([]), { driven: 0, even: 0, unscored: 0, total: 0 })
  })
})
