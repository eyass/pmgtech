'use client'

import { useState } from 'react'

import { MEDIAN, scoreDomain, ticksIn } from '@/lib/chart-scale'

/**
 * Where engineers sit against each other on two of the four dimensions.
 *
 * The ranked table below this chart is the same data ordered; this is the same
 * data placed, which answers a different question — not "who is first" but "who
 * sits apart from the group, and in which direction". Every value here is also in
 * that table, so the hover layer enhances and never gates.
 *
 * Three decisions are worth knowing about, because each is a choice against a
 * more flattering alternative:
 *
 * 1. **Neither axis ever zooms tighter than 40 points.** Fitting each axis to its
 *    data is what makes a scatter lie: this org's quality scores span 28 points
 *    against throughput's 64, and a fitted axis would stretch both to the same
 *    width and imply the same spread. 15 points is one interquartile range of a
 *    cohort, so a 40-point floor keeps a near-tie looking like a near-tie. The
 *    two axes can still end up with different spans, which is why the tick
 *    numbers are drawn rather than left implicit — distance across is not
 *    necessarily worth the same as distance up.
 * 2. **The lines are at 50 because 50 *is* the cohort median.** The quadrants are
 *    not a threshold somebody chose; they fall out of how the score is built, and
 *    the domain always contains 50 so they are always on the plot.
 * 3. **A label is only drawn where it can be unambiguous.** Naming a dot that is
 *    touching another dot points the name at both of them, so extremes only get a
 *    direct label when nothing else is close enough to steal it. The rest are
 *    reachable by hover, by keyboard, and in the table.
 */

export type ScatterPoint = {
  id: string
  name: string
  shortName: string
  x: number
  y: number
  squad: string | null
  level: string
  rank: number
  score: number | null
  /** False for thin data or no cohort — drawn hollow rather than in another colour. */
  solid: boolean
  confidenceNote: string | null
}

const PLOT_W = 620
const PLOT_H = 470
const PAD = { top: 18, right: 20, bottom: 52, left: 52 }
const W = PLOT_W + PAD.left + PAD.right
const H = PLOT_H + PAD.top + PAD.bottom

export function Scatter({
  points,
  xLabel,
  yLabel,
}: {
  points: ScatterPoint[]
  xLabel: string
  yLabel: string
}) {
  const [active, setActive] = useState<string | null>(null)

  if (points.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--color-muted)]">
        No engineer has a score on both of these dimensions in this period.
      </p>
    )
  }

  const xDomain = scoreDomain(points.map((p) => p.x))
  const yDomain = scoreDomain(points.map((p) => p.y))
  const px = (v: number) => PAD.left + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * PLOT_W
  const py = (v: number) => PAD.top + PLOT_H - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * PLOT_H

  const placed = points.map((p) => ({ ...p, cx: px(p.x), cy: py(p.y) }))

  // Direct labels go to the points furthest from the cohort median — and only to
  // those. The candidates are picked before the filters run, so a name skipped for
  // being crowded is simply not drawn; nothing is promoted in its place, because
  // backfilling would put labels on the most ordinary points on the plot.
  const labelled = new Set<string>()
  const candidates = [...placed]
    .sort((a, b) => Math.hypot(b.x - MEDIAN, b.y - MEDIAN) - Math.hypot(a.x - MEDIAN, a.y - MEDIAN))
    .slice(0, 6)
  for (const p of candidates) {
    // A name next to two touching dots points at both of them; leave those to hover.
    const crowded = placed.some((q) => q.id !== p.id && Math.hypot(q.cx - p.cx, q.cy - p.cy) < 30)
    if (crowded) continue
    const collides = [...labelled].some((id) => {
      const q = placed.find((c) => c.id === id)!
      return Math.hypot(q.cx - p.cx, q.cy - p.cy) < 52
    })
    if (collides) continue
    labelled.add(p.id)
  }

  const hovered = placed.find((p) => p.id === active) ?? null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${yLabel} against ${xLabel} for ${points.length} engineers`}
      >
        {/* --- grid, recessive ---------------------------------------------- */}
        {ticksIn(xDomain).map((t) => (
          <g key={`x${t}`}>
            <line
              x1={px(t)}
              x2={px(t)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={px(t)}
              y={PAD.top + PLOT_H + 17}
              textAnchor="middle"
              className="tnum fill-[var(--color-muted)] text-[10px]"
            >
              {t}
            </text>
          </g>
        ))}
        {ticksIn(yDomain).map((t) => (
          <g key={`y${t}`}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={py(t)}
              y2={py(t)}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 9}
              y={py(t) + 3}
              textAnchor="end"
              className="tnum fill-[var(--color-muted)] text-[10px]"
            >
              {t}
            </text>
          </g>
        ))}

        {/* --- the cohort median, which is what 50 means -------------------- */}
        <line
          x1={px(MEDIAN)}
          x2={px(MEDIAN)}
          y1={PAD.top}
          y2={PAD.top + PLOT_H}
          stroke="var(--chart-ref)"
          strokeWidth={1}
        />
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={py(MEDIAN)}
          y2={py(MEDIAN)}
          stroke="var(--chart-ref)"
          strokeWidth={1}
        />

        {/* Only the two diagonal corners are named — the other two follow from the
            axis titles, and four captions on one plot is clutter. */}
        <text
          x={PAD.left + PLOT_W - 4}
          y={PAD.top + 12}
          textAnchor="end"
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          above on both
        </text>
        <text
          x={PAD.left + 4}
          y={PAD.top + PLOT_H - 6}
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          below on both
        </text>

        {/* --- axis rules --------------------------------------------------- */}
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
          stroke="var(--chart-axis)"
          strokeWidth={1}
        />
        <line
          x1={PAD.left}
          x2={PAD.left}
          y1={PAD.top}
          y2={PAD.top + PLOT_H}
          stroke="var(--chart-axis)"
          strokeWidth={1}
        />
        <text
          x={PAD.left + PLOT_W / 2}
          y={H - 8}
          textAnchor="middle"
          className="fill-[var(--color-muted)] text-[11px]"
        >
          {xLabel} →
        </text>
        <text
          transform={`rotate(-90 12 ${PAD.top + PLOT_H / 2})`}
          x={12}
          y={PAD.top + PLOT_H / 2}
          textAnchor="middle"
          className="fill-[var(--color-muted)] text-[11px]"
        >
          {yLabel} →
        </text>

        {/* --- the points --------------------------------------------------- */}
        {placed.map((p) => {
          const dim = active !== null && p.id !== active
          const flip = p.cx > PAD.left + PLOT_W * 0.72
          return (
            <g key={p.id}>
              {/* 2px surface ring, so points that land on each other stay countable. */}
              <circle cx={p.cx} cy={p.cy} r={6.5} fill="var(--color-surface)" opacity={dim ? 0.4 : 1} />
              {/* The hovered mark answers back, rather than only its neighbours receding. */}
              {p.id === active ? (
                <circle
                  cx={p.cx}
                  cy={p.cy}
                  r={9.5}
                  fill="none"
                  stroke="var(--chart-series)"
                  strokeWidth={1.5}
                  opacity={0.55}
                />
              ) : null}
              <circle
                cx={p.cx}
                cy={p.cy}
                r={4.5}
                fill={p.solid ? 'var(--chart-series)' : 'var(--color-surface)'}
                stroke="var(--chart-series)"
                strokeWidth={p.solid ? 0 : 2}
                opacity={dim ? 0.35 : 1}
              />
              {labelled.has(p.id) ? (
                <text
                  x={flip ? p.cx - 10 : p.cx + 10}
                  y={p.cy + 3.5}
                  textAnchor={flip ? 'end' : 'start'}
                  className="fill-[var(--color-muted)] text-[10px]"
                  opacity={dim ? 0.4 : 1}
                >
                  {p.shortName}
                </text>
              ) : null}
              {/* A 26px transparent target: nobody reliably hits a 9px dot. */}
              <circle
                cx={p.cx}
                cy={p.cy}
                r={13}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${p.name}, ${xLabel} ${p.x.toFixed(1)}, ${yLabel} ${p.y.toFixed(1)}`}
                className="cursor-pointer outline-none focus-visible:stroke-[var(--color-ink)]"
                onMouseEnter={() => setActive(p.id)}
                onMouseLeave={() => setActive((c) => (c === p.id ? null : c))}
                onFocus={() => setActive(p.id)}
                onBlur={() => setActive((c) => (c === p.id ? null : c))}
              />
            </g>
          )
        })}
      </svg>

      {/* --- readout: value leads, label follows -------------------------- */}
      {hovered ? (
        <div
          className="pointer-events-none absolute z-10 w-56 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5 shadow-lg"
          style={{
            left: `${(hovered.cx / W) * 100}%`,
            top: `${(hovered.cy / H) * 100}%`,
            transform: `translate(${hovered.cx > W * 0.58 ? 'calc(-100% - 14px)' : '14px'}, ${
              hovered.cy > H * 0.58 ? 'calc(-100% - 14px)' : '14px'
            })`,
          }}
        >
          <p className="text-xs font-semibold">{hovered.name}</p>
          <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
            {hovered.level}
            {hovered.squad ? ` · ${hovered.squad}` : ''} · #{hovered.rank} in org
          </p>
          <dl className="mt-2 space-y-1">
            <Row label={xLabel} value={hovered.x} />
            <Row label={yLabel} value={hovered.y} />
            {hovered.score !== null ? <Row label="Overall" value={hovered.score} /> : null}
          </dl>
          {hovered.confidenceNote ? (
            <p className="mt-2 border-t border-[var(--color-line)] pt-1.5 text-[10px] text-[var(--color-muted)]">
              {hovered.confidenceNote}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* One series needs no legend, but the hollow dot is a second mark and has to
          say what it means. */}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-muted)]">
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden="true">
            <circle cx="6" cy="6" r="4" fill="var(--chart-series)" />
          </svg>
          Scored against a full cohort
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden="true">
            <circle
              cx="6"
              cy="6"
              r="3.5"
              fill="var(--color-surface)"
              stroke="var(--chart-series)"
              strokeWidth="2"
            />
          </svg>
          Thin data or no cohort — placement is indicative
        </span>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-[var(--color-muted)]">{label}</dt>
      <dd className="tnum text-xs font-semibold">{value.toFixed(1)}</dd>
    </div>
  )
}
