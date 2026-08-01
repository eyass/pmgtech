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

  // The ring is inset by half its own width so the drawn edge lands on `r` rather
  // than a pixel outside it — otherwise a hollow dot reads as larger than a solid
  // one at the same radius, which is exactly backwards.
  const ring = (
    <circle
      cx={cx}
      cy={cy}
      r={r - 1}
      fill={hollowFill}
      stroke={colour}
      strokeWidth={2}
      opacity={opacity}
    />
  )

  if (mark === 'hollow') return ring

  const inner = r - 2
  return (
    <g opacity={opacity}>
      {ring}
      <path d={`M ${cx} ${cy - inner} A ${inner} ${inner} 0 0 1 ${cx} ${cy + inner} Z`} fill={colour} />
    </g>
  )
}
