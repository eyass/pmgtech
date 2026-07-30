import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  absoluteDomain,
  bubbleRadius,
  fractionIn,
  measured,
  measuredPairs,
  scoreDomain,
} from '../src/lib/chart-scale.ts'

/**
 * The three ways the squad charts could lie, pinned so they cannot come back.
 *
 * These are not arithmetic checks for their own sake. Each one is a mistake that
 * looks fine on screen: a bubble chart sized by radius reads as a plausible
 * picture that overstates its biggest subject by the square, an axis cropped to a
 * ceiling reads as a plausible ranking that has quietly become relative, and a
 * missing sub-score drawn at 0 reads as a squad failing a target nobody measured.
 */

describe('bubble sizing is by area, not radius', () => {
  it('keeps area proportional to the value', () => {
    // Four engineers must cover four times the ink of one, not sixteen times.
    const one = bubbleRadius(1, 4, 20)
    const four = bubbleRadius(4, 4, 20)
    assert.ok(
      Math.abs((four / one) ** 2 - 4) < 1e-9,
      `area ratio should be 4, was ${(four / one) ** 2}`,
    )
    // The failure this guards against: sizing by radius would make it 16.
    assert.ok(four / one < 4, 'radius ratio must be smaller than the value ratio')
  })

  it('holds for every pair of headcounts this org has', () => {
    const headcounts = [1, 2, 3, 4]
    for (const a of headcounts) {
      for (const b of headcounts) {
        const ra = bubbleRadius(a, 4, 20)
        const rb = bubbleRadius(b, 4, 20)
        assert.ok(
          Math.abs(Math.PI * ra ** 2 * b - Math.PI * rb ** 2 * a) < 1e-6,
          `area(${a}) / area(${b}) should equal ${a}/${b}`,
        )
      }
    }
  })

  it('gives the largest subject exactly the radius budget', () => {
    assert.equal(bubbleRadius(4, 4, 20), 20)
    assert.equal(bubbleRadius(9, 4, 20), 20, 'a value above the max is clamped, never grown')
  })

  it('refuses to invent a radius for a subject with nothing to size by', () => {
    // No minimum radius on purpose: a floor would break the proportion for exactly
    // the smallest bubbles, so a squad with nobody in metrics gets zero here and
    // the component names it underneath the plot instead of drawing it.
    assert.equal(bubbleRadius(0, 4, 20), 0)
    assert.equal(bubbleRadius(-1, 4, 20), 0)
    assert.equal(bubbleRadius(3, 0, 20), 0)
  })
})

describe('a null sub-score is absent, never zero', () => {
  it('passes real numbers through, including a real zero', () => {
    assert.equal(measured(0), 0, 'a measured 0 is a real score at the bad threshold')
    assert.equal(measured(43), 43)
    assert.equal(measured(100), 100)
  })

  it('never turns a missing value into a number', () => {
    assert.equal(measured(null), null)
    assert.equal(measured(undefined), null)
    assert.equal(measured(Number.NaN), null)
    assert.equal(measured(Number.POSITIVE_INFINITY), null)
  })

  it("drops DevExp's null quality score instead of plotting it at 0", () => {
    // The real rows: DevExp has a genuine NULL quality score, and 0 on that axis
    // would read as the worst change-failure rate in the org rather than as an
    // unmeasured dimension.
    const squads = [
      { key: 'monetization', throughput: 100, quality: 99.5 },
      { key: 'buyer', throughput: 100, quality: 93 },
      { key: 'devexp', throughput: 43, quality: null as number | null },
      { key: 'security', throughput: null as number | null, quality: null as number | null },
    ]
    const { placed, absent } = measuredPairs(
      squads,
      (s) => s.throughput,
      (s) => s.quality,
    )

    assert.deepEqual(
      placed.map((p) => p.item.key),
      ['monetization', 'buyer'],
    )
    assert.deepEqual(
      absent.map((s) => s.key),
      ['devexp', 'security'],
    )
    assert.ok(
      !placed.some((p) => p.x === 0 || p.y === 0),
      'nothing unmeasured may arrive on an axis as 0',
    )
  })

  it('keeps a squad whose score really is zero', () => {
    const { placed, absent } = measuredPairs(
      [{ key: 'floor', throughput: 0, flow: 0 }],
      (s) => s.throughput,
      (s) => s.flow,
    )
    assert.equal(absent.length, 0)
    assert.deepEqual(placed[0]?.x, 0)
  })
})

describe('the squad axis does not rescale to its data', () => {
  // What the squads actually score: a hard cluster against the ceiling.
  const ceiling = [99.9, 98.3, 95.9, 94.8, 74.7]

  it('is the full 0-100 whatever the data does', () => {
    assert.deepEqual(absoluteDomain(), [0, 100])
    assert.equal(absoluteDomain.length, 0, 'it takes no data, so it cannot be made to crop')
  })

  it('places a clustered ceiling at the top of the axis, not across it', () => {
    const absolute = absoluteDomain()
    // 94.8 sits 95% along a fixed axis. That is the finding: the squads agree.
    assert.ok(Math.abs(fractionIn(94.8, absolute) - 0.948) < 1e-9)
    assert.ok(fractionIn(74.7, absolute) > 0.7, 'the bottom squad is still near the good end')

    // The engineer rule, on the same numbers, would crop and spread them out —
    // correct for a cohort scale, and exactly what must not happen here.
    const cropped = scoreDomain(ceiling)
    assert.ok(cropped[1] - cropped[0] < 100, 'the cohort rule crops')
    assert.ok(
      fractionIn(74.7, cropped) < fractionIn(74.7, absolute) - 0.15,
      'cropping would push the bottom squad far down an axis it has not actually fallen down',
    )
  })

  it('never moves the thresholds or the midpoint off the axis', () => {
    const absolute = absoluteDomain()
    assert.equal(fractionIn(0, absolute), 0)
    assert.equal(fractionIn(100, absolute), 1)
    assert.equal(fractionIn(50, absolute), 0.5, 'the target midpoint is genuinely halfway')

    // And it is unmoved by data that would drag any fitted domain around.
    for (const data of [[100, 100, 100], [44], [0, 1, 2], ceiling]) {
      assert.deepEqual(absoluteDomain(), [0, 100], `unmoved by ${JSON.stringify(data)}`)
    }
  })
})
