import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  compareProfiles,
  compositeGap,
  describeProfile,
  dimensionGap,
  gapTally,
  MATERIAL_GAP_POINTS,
  MAX_OVERLAID_SHAPES,
  medianProfile,
  overlayCheck,
  RADAR_AXES,
  RADAR_MAX,
  radarPoint,
  radarRing,
  radarShape,
  radarSpread,
  scoreGap,
  type RadarSubject,
  type RadarValues,
} from '../src/lib/radar-geometry.ts'

/**
 * A radar is the easiest chart in the app to make dishonest, so the things worth
 * pinning here are the ones that would let it drift that way without anybody
 * noticing: the coordinate maths, the fixed scale, the two-shape limit, and the
 * materiality gate that stops a two-point difference reading as a win.
 */

const GEOM = { cx: 100, cy: 100, radius: 80 }

const values = (
  throughput: number | null,
  flow: number | null,
  quality: number | null,
  collaboration: number | null,
): RadarValues => ({ throughput, flow, quality, collaboration })

const subject = (over: Partial<RadarSubject> & { name: string; values: RadarValues }): RadarSubject => ({
  id: over.name,
  score: null,
  solid: true,
  ...over,
})

// --- geometry ---------------------------------------------------------------

describe('radarPoint', () => {
  it('puts a known input on known points', () => {
    // The four axes sit exactly on the compass points, so these are exact rather
    // than approximate — no floating-point cosines anywhere in the geometry.
    assert.deepEqual(radarPoint('throughput', 100, GEOM), { x: 100, y: 20 })
    assert.deepEqual(radarPoint('flow', 100, GEOM), { x: 180, y: 100 })
    assert.deepEqual(radarPoint('quality', 100, GEOM), { x: 100, y: 180 })
    assert.deepEqual(radarPoint('collaboration', 100, GEOM), { x: 20, y: 100 })
  })

  it('places 50 — the cohort median — at half the radius', () => {
    assert.deepEqual(radarPoint('throughput', 50, GEOM), { x: 100, y: 60 })
    assert.deepEqual(radarPoint('flow', 50, GEOM), { x: 140, y: 100 })
    assert.deepEqual(radarPoint('quality', 25, GEOM), { x: 100, y: 120 })
    assert.deepEqual(radarPoint('collaboration', 75, GEOM), { x: 40, y: 100 })
  })

  it('collapses zero to the centre on every axis', () => {
    for (const axis of RADAR_AXES) {
      assert.deepEqual(radarPoint(axis.key, 0, GEOM), { x: 100, y: 100 })
    }
  })

  it('refuses an axis it does not know', () => {
    // @ts-expect-error — the guard exists for callers that are not type-checked.
    assert.throws(() => radarPoint('velocity', 50, GEOM), /Unknown radar axis/)
  })
})

describe('the radial scale is fixed, never fitted to the data', () => {
  // The whole value of small multiples rests on this: a cohort spanning three
  // points must not fill the ring like one spanning sixty.
  it('gives the same radius for the same value whatever else is on the chart', () => {
    const tight = values(48, 49, 50, 51)
    const wide = values(0, 33, 66, 100)
    const a = radarShape(tight, GEOM).vertices.find((v) => v.axis === 'quality')!
    const b = radarShape(wide, GEOM).vertices.find((v) => v.axis === 'quality')!
    // 50 on a near-flat profile and 66 on a full-range one are drawn where their
    // own values say, not where the profile's own spread would put them.
    assert.deepEqual({ x: a.x, y: a.y }, radarPoint('quality', 50, GEOM))
    assert.deepEqual({ x: b.x, y: b.y }, radarPoint('quality', 66, GEOM))
  })

  it('draws a three-point spread as a three-point spread', () => {
    const near = radarShape(values(48, 49, 50, 51), GEOM)
    const radii = near.vertices.map((v) => Math.hypot(v.x - GEOM.cx, v.y - GEOM.cy))
    // 48..51 of 100 across an 80px radius is 2.4px of variation, and that is all
    // it is allowed to be. A fitted radar would spread these across the ring.
    assert.ok(Math.max(...radii) - Math.min(...radii) < 3, `radii varied by ${Math.max(...radii) - Math.min(...radii)}`)
  })

  it('clamps out-of-range values instead of rescaling the chart around them', () => {
    assert.deepEqual(radarPoint('flow', 140, GEOM), radarPoint('flow', RADAR_MAX, GEOM))
    assert.deepEqual(radarPoint('flow', -20, GEOM), radarPoint('flow', 0, GEOM))
  })

  it('rings are the same size whatever the subject', () => {
    assert.equal(radarRing(50, GEOM), '100,60 140,100 100,140 60,100')
    assert.equal(radarRing(100, GEOM), '100,20 180,100 100,180 20,100')
  })
})

describe('the axis order is part of the contract', () => {
  it('is throughput, flow, quality, collaboration and nothing else', () => {
    assert.deepEqual(
      RADAR_AXES.map((a) => a.key),
      ['throughput', 'flow', 'quality', 'collaboration'],
    )
  })

  it('walks the outline in that order', () => {
    const { vertices } = radarShape(values(10, 20, 30, 40), GEOM)
    assert.deepEqual(
      vertices.map((v) => v.axis),
      ['throughput', 'flow', 'quality', 'collaboration'],
    )
  })
})

describe('radarShape with a dimension missing', () => {
  const { vertices, missing, points } = radarShape(values(43, 100, null, 81), GEOM)

  it('leaves the axis out rather than plotting it as zero', () => {
    assert.deepEqual(missing, ['quality'])
    assert.equal(vertices.length, 3)
    assert.ok(!vertices.some((v) => v.axis === 'quality'))
    assert.ok(!points.includes(`${GEOM.cx},${GEOM.cy}`), 'a missing axis must not become a vertex at the centre')
  })

  it('draws nothing at all below two measured dimensions', () => {
    assert.equal(radarShape(values(60, null, null, null), GEOM).points, '')
    assert.equal(radarShape(values(null, null, null, null), GEOM).vertices.length, 0)
  })
})

describe('radarSpread', () => {
  it('is zero for a balanced profile and large for a spike', () => {
    assert.equal(radarSpread(values(50, 50, 50, 50)), 0)
    // 63.3/98/49/69 has a mean of 69.825, and flow is furthest from it.
    assert.ok(radarSpread(values(63.3, 98, 49, 69))! > 20)
  })

  it('measures spread and not area — a small balanced shape is still balanced', () => {
    assert.equal(radarSpread(values(10, 10, 10, 10)), 0)
    assert.equal(radarSpread(values(90, 90, 90, 90)), 0)
  })

  it('has no answer below two measured dimensions', () => {
    assert.equal(radarSpread(values(50, null, null, null)), null)
  })
})

describe('medianProfile', () => {
  it('takes the median per axis, not the median person', () => {
    const group = [
      { values: values(10, 90, 50, 50) },
      { values: values(20, 80, 60, 40) },
      { values: values(30, 70, 40, 60) },
    ]
    assert.deepEqual(medianProfile(group), values(20, 80, 50, 50))
  })

  it('averages the middle two for an even group', () => {
    assert.deepEqual(
      medianProfile([{ values: values(10, 10, 10, 10) }, { values: values(20, 20, 20, 20) }]),
      values(15, 15, 15, 15),
    )
  })

  it('skips missing values rather than treating them as zero', () => {
    const group = [
      { values: values(10, null, 50, 50) },
      { values: values(20, 80, null, 50) },
      { values: values(30, 100, null, 50) },
    ]
    assert.deepEqual(medianProfile(group), values(20, 90, 50, 50))
  })

  it('leaves an axis nobody has data for as null', () => {
    assert.deepEqual(
      medianProfile([{ values: values(10, 10, null, 10) }]),
      values(10, 10, null, 10),
    )
  })
})

describe('describeProfile', () => {
  it('carries all four values and the composite, so the shape is never the only readout', () => {
    const text = describeProfile(
      subject({ name: 'A. Tokarz', values: values(63.3, 98, 49, 69), score: 69.8 }),
    )
    for (const fragment of ['throughput 63.3', 'flow 98.0', 'quality 49.0', 'collaboration 69.0']) {
      assert.ok(text.includes(fragment), `missing "${fragment}" from: ${text}`)
    }
    assert.ok(text.includes('composite 69.8 of 100'))
  })

  it('names a missing dimension as no data rather than as a number', () => {
    const text = describeProfile(subject({ name: 'DevExp', values: values(43, 100, null, 81) }))
    assert.ok(text.includes('quality no data'))
  })

  it('carries the thin-data caveat', () => {
    const text = describeProfile(
      subject({ name: 'A. Janjić', values: values(14.7, 0, 57.3, 25.7), score: 24.4, solid: false, note: 'Fewer than 5 merged merge requests' }),
    )
    assert.ok(text.includes('Thin data: Fewer than 5 merged merge requests'))
  })
})

// --- the two-shape limit ----------------------------------------------------

describe('overlayCheck — a radar carries two shapes, not more', () => {
  it('accepts exactly two', () => {
    assert.deepEqual(overlayCheck(2), { ok: true, count: 2 })
    assert.equal(MAX_OVERLAID_SHAPES, 2)
  })

  it('refuses three or more instead of drawing them', () => {
    for (const n of [3, 4, 8]) {
      const result = overlayCheck(n)
      assert.equal(result.ok, false, `${n} shapes should be refused`)
      assert.equal(result.ok === false && result.reason, 'too-many')
      assert.ok(result.ok === false && result.message.includes(String(n)))
    }
  })

  it('asks for a second subject rather than erroring when given one', () => {
    for (const n of [0, 1]) {
      const result = overlayCheck(n)
      assert.equal(result.ok, false, `${n} shapes is not a comparison`)
      assert.equal(result.ok === false && result.reason, 'too-few')
    }
  })
})

// --- materiality ------------------------------------------------------------

describe('the materiality rule', () => {
  it('is one cohort interquartile range, which is 15 points by construction', () => {
    assert.equal(MATERIAL_GAP_POINTS, 15)
  })

  const side = (name: string, value: number | null, solid = true) => ({ name, value, solid })

  it('calls a 2-point difference the same score, not a win', () => {
    const result = scoreGap(side('A', 50), side('B', 48))
    assert.equal(result.verdict, 'same')
    assert.equal(result.leader, null)
    assert.equal(result.gap, 2)
  })

  it('still says the same at 14.9 points, and only speaks at 15', () => {
    assert.equal(scoreGap(side('A', 50), side('B', 35.1)).verdict, 'same')
    assert.equal(scoreGap(side('A', 50), side('B', 35)).verdict, 'material')
  })

  it('names the leader only once the gap is real', () => {
    assert.equal(scoreGap(side('A', 70), side('B', 40)).leader, 'a')
    assert.equal(scoreGap(side('A', 40), side('B', 70)).leader, 'b')
    assert.equal(scoreGap(side('A', 55), side('B', 50)).leader, null)
  })

  it('is symmetric — the gap is a distance, not a direction', () => {
    const forward = scoreGap(side('A', 70), side('B', 40))
    const backward = scoreGap(side('B', 40), side('A', 70))
    assert.equal(forward.gap, backward.gap)
    assert.equal(forward.verdict, backward.verdict)
  })

  it('reads a missing score as not readable rather than as equal', () => {
    const result = scoreGap(side('A', null), side('B', 50))
    assert.equal(result.verdict, 'unreadable')
    assert.equal(result.gap, null)
    assert.ok(result.reason.includes('A has no score'))
    assert.equal(scoreGap(side('A', null), side('B', null)).verdict, 'unreadable')
  })

  it('withholds the verdict when either score rests on thin data, however big the gap', () => {
    // 0018's order: "cannot see" is suppressed before "nothing there", and a gap
    // between one solid score and one indicative score is not defensible.
    const thin = scoreGap(side('A', 90), side('B', 20, false))
    assert.equal(thin.verdict, 'unreadable')
    assert.equal(thin.leader, null)
    assert.equal(thin.gap, 70, 'the number is still shown; only the claim is withheld')
    assert.ok(thin.reason.includes('B'))
    assert.equal(scoreGap(side('A', 90, false), side('B', 20)).verdict, 'unreadable')
    assert.ok(scoreGap(side('A', 90, false), side('B', 20, false)).reason.includes('Both'))
  })
})

describe('dimensionGap and compareProfiles', () => {
  const tokarz = subject({
    name: 'Aleksandra Tokarz',
    values: values(63.3, 98, 49, 69),
    score: 69.8,
  })
  const fejzovic = subject({
    name: 'Dina Fejzović Durmiš',
    values: values(54.7, 53, 44.5, 61.7),
    score: 53.5,
  })

  it('finds the one real difference between two real senior engineers', () => {
    const gaps = compareProfiles(tokarz, fejzovic)
    assert.deepEqual(
      gaps.map((g) => `${g.axis}:${g.verdict}`),
      ['throughput:same', 'flow:material', 'quality:same', 'collaboration:same'],
    )
    // Throughput is 8.6 points apart and reads the same, which is the whole point:
    // the ranking puts 16 points between these two and only flow is behind it.
    assert.equal(gaps.find((g) => g.axis === 'flow')!.leader, 'a')
  })

  it('returns the dimensions in the fixed axis order', () => {
    assert.deepEqual(
      compareProfiles(tokarz, fejzovic).map((g) => g.axis),
      RADAR_AXES.map((a) => a.key),
    )
  })

  it('labels each row with the axis name', () => {
    assert.equal(dimensionGap('collaboration', tokarz, fejzovic).label, 'Collaboration')
  })

  it('applies the same gate to the composite as to the parts', () => {
    const composite = compositeGap(tokarz, fejzovic)
    assert.equal(composite.verdict, 'material')
    assert.equal(composite.leader, 'a')

    // The two mid-level engineers 4.9 points apart in the org ranking are the same
    // score overall, and this is the row that has to say so before a calibration
    // meeting — even though two of their dimensions do separate. Flow is exactly
    // 15.0 apart here, which lands on the gate and is allowed to speak.
    const ashraf = subject({ name: 'Dina Ashraf', values: values(74.7, 58, 40.3, 57.3), score: 57.6 })
    const vrbanec = subject({ name: 'Marko Vrbanec', values: values(59, 43, 46.3, 62.3), score: 52.7 })
    assert.equal(compositeGap(ashraf, vrbanec).verdict, 'same')
    assert.deepEqual(
      compareProfiles(ashraf, vrbanec).map((g) => `${g.axis}:${g.verdict}`),
      ['throughput:material', 'flow:material', 'quality:same', 'collaboration:same'],
    )
  })

  it('tallies the verdicts, so a headline cannot report "nothing there" for "cannot see"', () => {
    const thin = subject({
      name: 'Aleksa Janjić',
      values: values(14.7, 0, 57.3, 25.7),
      score: 24.4,
      solid: false,
      note: 'Fewer than 5 merged merge requests',
    })
    // A 98-vs-0 flow gap must not be counted as "same" just because the verdict
    // was withheld — that is what makes the tally three-valued rather than two.
    assert.deepEqual(gapTally(compareProfiles(tokarz, thin)), {
      material: 0,
      same: 0,
      unreadable: 4,
    })
    assert.deepEqual(gapTally(compareProfiles(tokarz, fejzovic)), {
      material: 1,
      same: 3,
      unreadable: 0,
    })
  })

  it('names the leader in the reason, so the direction survives a narrow chart', () => {
    const flow = dimensionGap('flow', tokarz, fejzovic)
    assert.ok(flow.reason.endsWith('Aleksandra Tokarz ahead'), flow.reason)
    assert.ok(dimensionGap('flow', fejzovic, tokarz).reason.endsWith('Aleksandra Tokarz ahead'))
  })

  it('marks a dimension nobody measured as not readable', () => {
    const devexp = subject({ name: 'DevExp', values: values(43, 100, null, 81), score: 74.7 })
    const seller = subject({ name: 'Team Seller', values: values(100, 98, 81, 100), score: 94.8 })
    const quality = compareProfiles(devexp, seller).find((g) => g.axis === 'quality')!
    assert.equal(quality.verdict, 'unreadable')
    assert.equal(quality.gap, null)
  })
})
