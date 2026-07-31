import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MIN_PRESENCE_FRACTION,
  daysPresent,
  describePresence,
  presence,
  prorate,
  validateStartDate,
  windowDays,
} from '../src/lib/tenure.ts'

/**
 * The arithmetic `0028_tenure_normalisation.sql` divides every counting metric by.
 *
 * The scoring itself is SQL and is exercised against the database; what is pinned
 * here is the part that has no natural error signal. A proration that is inverted,
 * off by a day, or that quietly treats "no start date" as "here the whole time"
 * still produces a plausible number in the right range, on the right page, next to
 * the right person. Nothing goes red. So the cases below are the ones the
 * migration's comments call out by name, including the two that exist in the real
 * table today: an engineer eleven days into a ninety-day window, and a start date
 * in the future.
 *
 * The window used throughout is the one the app defaults to — 2026-05-02 to
 * 2026-07-31, ninety days — because those are the numbers in the migration header
 * and the ones the before/after was measured on.
 */

const FROM = '2026-05-02T00:00:00.000Z'
const TO = '2026-07-31T00:00:00.000Z'

describe('windowDays', () => {
  it('measures the default 90-day window as 90 days', () => {
    assert.equal(windowDays(FROM, TO), 90)
  })

  it('ignores the time of day, matching the migration truncating to a UTC date', () => {
    assert.equal(windowDays('2026-05-02T23:59:00.000Z', '2026-07-31T00:01:00.000Z'), 90)
  })

  it('never returns zero, so nothing can divide by an empty window', () => {
    assert.equal(windowDays(TO, TO), 1)
  })
})

describe('daysPresent', () => {
  it('gives the whole window to someone who started before it', () => {
    assert.equal(daysPresent('2021-06-01', FROM, TO), 90)
  })

  it('gives the whole window to someone who started on the first day of it', () => {
    assert.equal(daysPresent('2026-05-02', FROM, TO), 90)
  })

  it('gives 11 of 90 to the engineer who joined eleven days before the window ended', () => {
    // Aleksa Janjić, start 2026-07-20, the row this migration was written for.
    assert.equal(daysPresent('2026-07-20', FROM, TO), 11)
  })

  it('gives exactly half a window to someone who started halfway through', () => {
    assert.equal(daysPresent('2026-06-16', FROM, TO), 45)
  })

  /**
   * The one that matters most, because a negative here does not error — it inverts
   * every prorated rate and publishes an enormous, confident, backwards score.
   */
  it('clamps a future start date to zero rather than to a negative', () => {
    assert.equal(daysPresent('2026-08-10', FROM, TO), 0)
    assert.equal(daysPresent('2027-01-01', FROM, TO), 0)
  })

  it('treats a start date on the window end as zero days, not one', () => {
    assert.equal(daysPresent('2026-07-31', FROM, TO), 0)
  })

  it('returns null for a missing start date rather than the window length', () => {
    assert.equal(daysPresent(null, FROM, TO), null)
    assert.equal(daysPresent(undefined, FROM, TO), null)
    assert.equal(daysPresent('', FROM, TO), null)
  })
})

describe('presence', () => {
  it('leaves a full-window engineer at a factor of exactly 1', () => {
    const p = presence('2021-06-01', FROM, TO)
    assert.equal(p.fraction, 1)
    assert.equal(p.inCohortMedian, true)
    assert.equal(p.notYetPresent, false)
    assert.equal(p.known, true)
  })

  it('puts eleven of ninety days below the floor and out of the median', () => {
    const p = presence('2026-07-20', FROM, TO)
    assert.equal(p.daysPresent, 11)
    assert.equal(p.windowDays, 90)
    assert.ok(Math.abs(p.fraction! - 11 / 90) < 1e-12)
    assert.equal(p.inCohortMedian, false)
  })

  it('admits exactly half a window — the floor is inclusive', () => {
    const p = presence('2026-06-16', FROM, TO)
    assert.equal(p.fraction, MIN_PRESENCE_FRACTION)
    assert.equal(p.inCohortMedian, true)
  })

  it('refuses one day short of half a window', () => {
    const p = presence('2026-06-17', FROM, TO)
    assert.equal(p.daysPresent, 44)
    assert.equal(p.inCohortMedian, false)
  })

  it('marks a future start date as not yet present, and out of the median', () => {
    const p = presence('2026-08-10', FROM, TO)
    assert.equal(p.daysPresent, 0)
    assert.equal(p.notYetPresent, true)
    assert.equal(p.inCohortMedian, false)
  })

  /**
   * The dangerous default, refused. A missing start date is *unknown* presence, and
   * treating it as full presence would produce a completely ordinary-looking score
   * with a completely ordinary-looking rank — nothing on the row would hint that
   * the tenure behind it was never established.
   */
  it('does not assume full tenure when there is no start date', () => {
    const p = presence(null, FROM, TO)
    assert.equal(p.known, false)
    assert.equal(p.daysPresent, null)
    assert.equal(p.fraction, null)
    assert.equal(p.inCohortMedian, false)
    assert.notEqual(p.fraction, 1)
  })
})

describe('prorate', () => {
  it('is the identity at full presence, so a full-window score cannot move', () => {
    for (const value of [0, 1, 2.16, 40, 100.27, 222]) {
      assert.equal(prorate(value, 1), value)
    }
  })

  it('restates eleven days of work as the rate it implies over ninety', () => {
    // 2.16 weighted merge requests in 11 of 90 days -> 17.67 over a full window,
    // which is what the migration prototype produced against production.
    const p = presence('2026-07-20', FROM, TO)
    assert.equal(round2(prorate(2.16, p.fraction)!), 17.67)
    assert.equal(round2(prorate(1, p.fraction)!), 8.18)
  })

  it('doubles a half-window rate and no more', () => {
    assert.equal(prorate(30, 0.5), 60)
  })

  it('scales zero to zero — no work over a part period is still no work', () => {
    assert.equal(prorate(0, 11 / 90), 0)
  })

  it('leaves the value alone when presence is unknown rather than inventing a factor', () => {
    assert.equal(prorate(40, null), 40)
  })

  it('withholds rather than dividing by zero for someone who had not started', () => {
    assert.equal(prorate(5, 0), null)
  })
})

describe('describePresence', () => {
  it('says the fraction out loud, in the numbers the score was divided by', () => {
    const p = presence('2026-07-20', FROM, TO)
    assert.match(describePresence(p, '2026-07-20'), /^Present for 11 of 90 days in this period/)
  })

  it('names the start date when it falls after the period', () => {
    const p = presence('2026-08-10', FROM, TO)
    assert.match(describePresence(p, '2026-08-10'), /2026-08-10 falls after this period/)
  })

  it('says the tenure is unestablished rather than implying there was none', () => {
    const text = describePresence(presence(null, FROM, TO), null)
    assert.match(text, /No start date on record/)
    assert.match(text, /left out of the cohort median/)
  })
})

describe('validateStartDate', () => {
  it('accepts a plain calendar date', () => {
    const check = validateStartDate('2026-07-20')
    assert.ok(check.ok && check.date === '2026-07-20')
  })

  it('accepts a future date, because a signed offer is a real row', () => {
    assert.ok(validateStartDate('2026-08-10', new Date('2026-07-31T00:00:00Z')).ok)
  })

  it('refuses a date so far out that it can only be a typo', () => {
    const check = validateStartDate('2126-08-10', new Date('2026-07-31T00:00:00Z'))
    assert.equal(check.ok, false)
  })

  it('refuses a day that does not exist', () => {
    assert.equal(validateStartDate('2025-02-30').ok, false)
    assert.equal(validateStartDate('2025-13-01').ok, false)
  })

  it('refuses anything that is not yyyy-mm-dd', () => {
    assert.equal(validateStartDate('20/07/2026').ok, false)
    assert.equal(validateStartDate('July 2026').ok, false)
    assert.equal(validateStartDate('').ok, false)
  })

  it('refuses a date before 2000, which is a mistyped year rather than a tenure', () => {
    assert.equal(validateStartDate('0202-07-20').ok, false)
  })
})

/**
 * The regression the whole change is measured against: an engineer who was here for
 * the whole window is scored on exactly the inputs they were scored on before, so
 * their composite and their rank cannot move. Everything the migration does to them
 * reduces to dividing by one.
 */
describe('a full-window engineer is untouched', () => {
  const inputs = {
    throughputUnits: 73.62,
    issuesResolved: 72,
    reviewsGiven: 109,
    revertsAuthored: 0,
  }

  it('divides every rate input by exactly one', () => {
    const p = presence('2022-06-01', FROM, TO)
    assert.equal(p.fraction, 1)
    for (const value of Object.values(inputs)) {
      assert.equal(prorate(value, p.fraction), value)
    }
  })

  it('holds for every window the app offers, not just 90 days', () => {
    const to = new Date('2026-07-31T00:00:00.000Z')
    for (const days of [7, 30, 90, 180, 365]) {
      const from = new Date(to.getTime() - days * 86_400_000)
      const p = presence('2021-06-01', from, to)
      assert.equal(p.windowDays, days)
      assert.equal(p.daysPresent, days)
      assert.equal(p.fraction, 1)
      assert.equal(p.inCohortMedian, true)
      assert.equal(prorate(inputs.throughputUnits, p.fraction), inputs.throughputUnits)
    }
  })
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
