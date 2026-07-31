'use client'

import { useRef, useState } from 'react'

import { absoluteDomain, scoreDomain } from '@/lib/chart-scale'
import {
  captureLabel,
  describeTrend,
  scoreTrend,
  signed,
  sortPoints,
  trendBadge,
  versionRuns,
  type ScorePoint,
} from '@/lib/score-history'
import { captureX, polylinePoints, scoreY } from '@/lib/trend-geometry'

/**
 * What a stored score has done since it started being stored, small enough to sit
 * in a table cell next to the score itself.
 *
 * A sparkline is the most flattering chart there is: it has no axis, so any wobble
 * fills the box, and it connects whatever it is given. Three rules keep this one
 * honest, and all three are enforced outside this file so they can be tested.
 *
 * 1. **One capture draws no line.** With a single snapshot there is nothing to
 *    connect, and the tempting rendering — a flat line across the box — is a claim
 *    that the score was measured twice and did not move. It was measured once. The
 *    state says so, and there is no backfill that could change that: the formula
 *    that produced June's score no longer exists in the database.
 * 2. **Nothing is drawn across a `definition_version` boundary.** A run of captures
 *    under one formula is one polyline; the next formula starts a new one, with a
 *    reference rule in the gap. Joining them would draw a slope nobody measured.
 * 3. **A difference smaller than one interquartile range is not a movement.** The
 *    badge reads "no material change" rather than a number, so a table of fourteen
 *    engineers cannot be skimmed as fourteen small movements when it is fourteen
 *    instances of nothing happening. The number itself is in the readout, which is
 *    what a reader gets when they ask for the detail rather than when they glance.
 *
 * The scale comes from `chart-scale.ts` and is chosen by the caller, because the two
 * altitudes have opposite rules: an engineer's score is relative and gets
 * `scoreDomain`'s 40-point floor so a near-tie looks like a near-tie, while a squad's
 * score is against absolute targets and must never rescale to its own data.
 */

export type TrendSparklineProps = {
  /** Every capture of one subject. Sorted here, so callers need not. */
  points: ScorePoint[]
  /** The subject's name, for the readout and the accessible label. */
  label: string
  /**
   * Which axis rule applies. `cohort` for engineer scores (relative, 40-point
   * minimum span); `absolute` for squad scores, which are scored against fixed
   * thresholds and are never fitted to their own spread.
   */
  scale: 'cohort' | 'absolute'
}

const W = 92
const H = 26
const PAD = { x: 6, y: 5 }

export function TrendSparkline({ points, label, scale }: TrendSparklineProps) {
  const anchor = useRef<SVGRectElement | null>(null)
  // Fixed rather than absolute, positioned from the trigger's own rect on open.
  // These live inside `Table`, whose `overflow-x-auto` makes the vertical axis a
  // clipping context too, so an absolutely positioned panel on the last row would be
  // cut off or would grow a scrollbar. The readout is a detail layer either way — the
  // state is on the page as text and in the accessible label — but a detail layer
  // that is unreachable on some rows and not others is worse than none.
  const [at, setAt] = useState<{ right: number; edge: number; above: boolean } | null>(null)

  const open = (): void => {
    const rect = anchor.current?.getBoundingClientRect()
    if (!rect) return
    const above = rect.bottom > window.innerHeight * 0.55
    setAt({
      right: window.innerWidth - rect.right,
      // Below the badge, not just below the plot: the state label sits under the svg
      // and the panel must not cover the one part of this that never needs hovering.
      edge: above ? window.innerHeight - rect.top + 6 : rect.bottom + 20,
      above,
    })
  }
  const close = (): void => setAt(null)

  const sorted = sortPoints(points)
  const trend = scoreTrend(sorted)
  const scoredPoints = sorted.filter(
    (p): p is ScorePoint & { score: number } => p.score !== null && Number.isFinite(p.score),
  )

  const badge = trendBadge(trend)
  const readout = describeTrend(trend)

  if (scoredPoints.length === 0) {
    return (
      <span className="text-[10px] text-[var(--color-muted)]" title={readout}>
        {badge}
      </span>
    )
  }

  const domain =
    scale === 'absolute' ? absoluteDomain() : scoreDomain(scoredPoints.map((p) => p.score))
  const index = new Map(sorted.map((p, i) => [p.capturedFor, i]))
  const x = (day: string) => captureX(index.get(day) ?? 0, sorted.length, PAD.x, W - PAD.x)
  // A lone capture is drawn on the centre line rather than at its value. With no
  // second point there is no scale to read a height against, and a dot near the top
  // of an empty box reads as "high" — a claim the single measurement cannot make.
  const y = (score: number) =>
    scoredPoints.length < 2 ? H / 2 : scoreY(score, domain, PAD.y, H - PAD.y)

  // One polyline per version run: the break *is* the statement that the two stretches
  // are not comparable, so it must never be bridged.
  const runs = versionRuns(sorted)
    .map((run) => run.filter((p) => p.score !== null))
    .filter((run) => run.length > 1)
    .map((run) => polylinePoints(run.map((p) => ({ x: x(p.capturedFor), y: y(p.score!) }))))

  // Where a formula changed, drawn between the two captures it falls between.
  const breaks: number[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.definitionVersion !== sorted[i - 1]!.definitionVersion) {
      breaks.push((x(sorted[i - 1]!.capturedFor) + x(sorted[i]!.capturedFor)) / 2)
    }
  }

  const last = scoredPoints[scoredPoints.length - 1]!

  return (
    <span className="relative inline-flex flex-col items-end gap-0.5">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="overflow-visible"
        role="img"
        aria-hidden="true"
      >
        {breaks.map((bx) => (
          <line
            key={bx}
            x1={bx}
            x2={bx}
            y1={2}
            y2={H - 2}
            stroke="var(--chart-ref)"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        ))}
        {runs.map((pts) => (
          <polyline
            key={pts}
            points={pts}
            fill="none"
            stroke="var(--chart-series)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {scoredPoints.map((p) => {
          const solid = p.confidence === 'high'
          const isLast = p === last
          return (
            <g key={p.capturedFor}>
              {/* 2px surface ring, so two captures close together stay countable. */}
              <circle cx={x(p.capturedFor)} cy={y(p.score)} r={isLast ? 3.6 : 2.8} fill="var(--color-surface)" />
              <circle
                cx={x(p.capturedFor)}
                cy={y(p.score)}
                r={isLast ? 2.4 : 1.6}
                fill={solid ? 'var(--chart-series)' : 'var(--color-surface)'}
                stroke="var(--chart-series)"
                strokeWidth={solid ? 0 : 1.4}
              />
            </g>
          )
        })}
        {/* The hit target is the whole box: 92 × 26, comfortably past the 24px floor,
            and identical for a pointer and for the keyboard. */}
        <rect
          x={0}
          y={0}
          width={W}
          height={H}
          fill="transparent"
          tabIndex={0}
          role="button"
          aria-label={`${label} score trend. ${readout}`}
          className="cursor-help outline-none focus-visible:stroke-[var(--color-ink)]"
          ref={anchor}
          onMouseEnter={open}
          onMouseLeave={close}
          onFocus={open}
          onBlur={close}
        />
      </svg>

      {/* The state is always on the page as text, so nothing here needs hovering to
          be read — the panel below only adds the dates and the exact numbers. */}
      <span
        className={`text-[10px] leading-none ${
          trend.kind === 'material' ? 'font-medium' : 'text-[var(--color-muted)]'
        }`}
      >
        {badge}
      </span>

      {at ? (
        <span
          className="pointer-events-none fixed z-30 block w-64 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5 text-left shadow-lg"
          style={at.above ? { right: at.right, bottom: at.edge } : { right: at.right, top: at.edge }}
        >
          <span className="block text-xs font-semibold">{label}</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-[var(--color-muted)]">
            {readout}
          </span>
          <span className="mt-1.5 block border-t border-[var(--color-line)] pt-1.5 text-[10px] text-[var(--color-muted)]">
            {scoredPoints.map((p) => (
              <span key={p.capturedFor} className="tnum block">
                {captureLabel(p.capturedFor)} · {p.score.toFixed(1)}
                {p.rankInOrg !== null ? ` · #${p.rankInOrg}` : ''} · {p.definitionVersion}
              </span>
            ))}
          </span>
          {trend.kind === 'immaterial' ? (
            <span className="mt-1.5 block text-[10px] text-[var(--color-muted)]">
              Raw difference {signed(trend.change)}, below the {trend.gap}-point gate.
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
