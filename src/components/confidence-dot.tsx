import { type ConfidenceMark } from '@/lib/score-confidence'

/**
 * One engineer's dot, drawn in the shape its confidence flag earns.
 *
 * Three shapes for four states, because `thin` and `no_cohort` say the same thing
 * to a reader ("we do not know much here") while `partial_window` says something
 * else entirely ("we know this, and they were here for part of the period, ranked
 * against a median they are not in"). Which state maps to which shape is decided
 * once in `score-confidence.ts` and never here — this file only knows how to draw
 * the three shapes.
 *
 * Shape rather than colour, deliberately. The caveat has to survive greyscale, a
 * printout and a reader who cannot distinguish the palette, and it has to survive
 * sitting on top of a tie band that is already using colour for something else.
 *
 * The half dot is filled on the **right**, towards the top of the score axis, so on
 * a horizontal chart the filled half faces the direction the score is claiming. It
 * is a half because half a period is the thing it means.
 *
 * No `'use client'`: there are no hooks and no handlers here, so this renders on
 * whichever side imports it.
 */
export function ConfidenceDot({
  cx,
  cy,
  r,
  mark,
  colour = 'var(--chart-series)',
  hollowFill = 'var(--color-surface)',
  opacity = 1,
}: {
  cx: number
  cy: number
  /**
   * The circle's radius, and for the two outlined marks the ring's *centreline* —
   * the 2px stroke straddles it, exactly as the hand-written circles these replaced
   * did. Keeping that meaning rather than "outer extent" is deliberate: three charts
   * had their dot sizes and beeswarm gaps tuned against it, and redefining the
   * radius would have quietly grown every solid dot on the page by a pixel.
   */
  r: number
  mark: ConfidenceMark
  colour?: string
  /** What shows through an unfilled dot. `none` where the backdrop should. */
  hollowFill?: string
  opacity?: number
}) {
  if (mark === 'solid') {
    return <circle cx={cx} cy={cy} r={r} fill={colour} opacity={opacity} />
  }

  const ring = (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill={hollowFill}
      stroke={colour}
      strokeWidth={2}
      opacity={opacity}
    />
  )

  if (mark === 'hollow') return ring

  // The half disc runs out to the ring's centreline so its curved edge tucks under
  // the inner half of the stroke. Stopping at the stroke's inner edge instead left a
  // white crescent that read as a rendering fault rather than as half a dot.
  return (
    <g opacity={opacity}>
      {ring}
      <path d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} Z`} fill={colour} />
    </g>
  )
}
