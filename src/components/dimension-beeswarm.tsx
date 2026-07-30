'use client'

import { useState } from 'react'

import { MEDIAN, scoreDomain, ticksIn } from '@/lib/chart-scale'
import { beeswarmLanes } from '@/lib/rank-bands'

/**
 * Which dimension is actually doing the separating.
 *
 * Four rows, one per dimension, every engineer as a dot in each row. The composite
 * weights the four equally and says so, which makes it easy to assume they
 * contribute equally. They do not. In this org throughput spans 60 points and
 * quality spans 28 — the same 25% of the composite, but throughput moves people
 * twice as far. Nothing on the page shows that today, and it is the first thing to
 * know before reading any of the rankings: a composite built from one wide
 * dimension and three narrow ones is mostly a ranking of the wide one.
 *
 * Three things make the comparison legible rather than merely pretty:
 *
 * - **One shared axis for all four rows.** Giving each row its own domain is the
 *   exact lie `chart-scale.ts` exists to prevent: it would stretch quality's 28
 *   points to the same width as throughput's 60 and make the two look identical,
 *   which is the opposite of the finding. Each row's span is printed as a number
 *   beside it too, so the comparison does not rest on eyeballing widths.
 * - **A median tick per row, and 50 drawn once across all of them.** 50 is where
 *   `score_vs_cohort` puts the cohort median by construction; a row's own median
 *   sitting away from it means the dimension's cohorts are unbalanced, not that the
 *   org is good or bad at that dimension.
 * - **A real beeswarm, offset deterministically.** Dots collide badly at this scale —
 *   quality's fourteen dots share 28 points of axis — so they are pushed into
 *   vertical lanes by `beeswarmLanes`, which lays them out in ascending position and
 *   takes the innermost free lane. No randomness: the same data draws the same
 *   picture every render, and a permuted input draws it identically, because a
 *   chart that reshuffles between two loads cannot be compared against itself.
 *
 * Hovering or focusing one dot lights that engineer in **all four rows**, which is
 * the other question this shape can answer: whether somebody is even across the
 * dimensions or carried by one.
 */

export type DimensionBeeswarmEngineer = {
  id: string
  name: string
  /** Used for the direct labels on a row's extremes. */
  shortName: string
  level: string
  squad: string | null
  /** False for thin data or no cohort — drawn hollow rather than in another colour. */
  solid: boolean
  confidenceNote: string | null
  /** Null where the dimension had no data — dropped, never counted as zero. */
  throughput: number | null
  flow: number | null
  quality: number | null
  collaboration: number | null
}

const DIMENSIONS = [
  { key: 'throughput', label: 'Throughput' },
  { key: 'flow', label: 'Flow' },
  { key: 'quality', label: 'Quality' },
  { key: 'collaboration', label: 'Collaboration' },
] as const

const LABEL_W = 112
const TRACK_W = 430
const STATS_W = 146
const LANE_H = 9
/** Clear air above and below the deepest lane, so the median tick's ends show. */
const ROW_PAD = 26
const PAD = { top: 34, bottom: 34 }
const W = LABEL_W + TRACK_W + STATS_W
/** Dot diameter plus the 2px surface ring either side: what actually overlaps. */
const MIN_GAP = 12

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function DimensionBeeswarm({ engineers }: { engineers: DimensionBeeswarmEngineer[] }) {
  const [active, setActive] = useState<string | null>(null)

  const everything = DIMENSIONS.flatMap((d) =>
    engineers.map((e) => e[d.key]).filter((v): v is number => v !== null),
  )
  if (everything.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--color-muted)]">
        No dimension has a score for anybody in this period.
      </p>
    )
  }

  // One domain for all four rows. Per-row domains would make 28 points look like 60.
  const domain = scoreDomain(everything)
  const px = (v: number) => LABEL_W + ((v - domain[0]) / (domain[1] - domain[0])) * TRACK_W

  const rows = DIMENSIONS.map((dimension) => {
    const members = engineers
      .filter((e) => e[dimension.key] !== null)
      .map((e) => ({ engineer: e, value: e[dimension.key] as number }))
    const lanes = beeswarmLanes(
      members.map((m) => ({ id: m.engineer.id, position: px(m.value) })),
      MIN_GAP,
    )
    const maxLane = Math.max(0, ...[...lanes.values()].map(Math.abs))
    const values = members.map((m) => m.value)
    return {
      ...dimension,
      members: members.map((m) => ({ ...m, lane: lanes.get(m.engineer.id) ?? 0 })),
      maxLane,
      med: median(values),
      lo: values.length ? Math.min(...values) : null,
      hi: values.length ? Math.max(...values) : null,
      height: Math.max(46, (2 * maxLane + 1) * LANE_H + ROW_PAD),
    }
  })

  // Rows are as tall as their deepest swarm, so a stack of them needs running
  // offsets. Four rows makes the repeated sum free, and it keeps the layout a pure
  // expression rather than a counter mutated inside a callback.
  const laidOut = rows.map((row, i) => {
    const top = PAD.top + rows.slice(0, i).reduce((n, r) => n + r.height, 0)
    return { ...row, top, centre: top + row.height / 2 }
  })
  const axisBottom = PAD.top + rows.reduce((n, r) => n + r.height, 0)
  const H = axisBottom + PAD.bottom

  // Direct labels go to each row's two extremes, chosen before the crowding filter.
  // A skipped one is not backfilled onto the next dot in; the middle of a beeswarm
  // is the last place a name belongs.
  const labelled = new Set<string>()
  for (const row of laidOut) {
    if (row.members.length < 3) continue
    const sorted = [...row.members].sort((a, b) => a.value - b.value)
    for (const end of [sorted[0]!, sorted[sorted.length - 1]!]) {
      const crowded = row.members.some(
        (m) => m.engineer.id !== end.engineer.id && Math.abs(px(m.value) - px(end.value)) < 22,
      )
      if (crowded) continue
      labelled.add(`${row.key}:${end.engineer.id}`)
    }
  }

  const hovered = engineers.find((e) => e.id === active) ?? null
  const hoveredRow = hovered
    ? laidOut.find((r) => r.members.some((m) => m.engineer.id === hovered.id))
    : undefined
  const hoveredMember = hoveredRow?.members.find((m) => m.engineer.id === hovered?.id)

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Score distribution of ${engineers.length} engineers across the four dimensions`}
      >
        {/* --- grid ------------------------------------------------------------ */}
        {ticksIn(domain).map((t) => (
          <g key={t}>
            <line x1={px(t)} x2={px(t)} y1={PAD.top - 8} y2={axisBottom} stroke="var(--chart-grid)" />
            <text
              x={px(t)}
              y={axisBottom + 16}
              textAnchor="middle"
              className="tnum fill-[var(--color-muted)] text-[10px]"
            >
              {t}
            </text>
          </g>
        ))}
        {/* 50 is dashed and the row medians are solid, capped ticks. Two of these rows
            have a median within a couple of points of 50, and drawn as two solid greys
            eight pixels apart they read as one confused mark; a dash says "reference"
            and survives greyscale, which a second hue would not. */}
        <line
          x1={px(MEDIAN)}
          x2={px(MEDIAN)}
          y1={PAD.top - 8}
          y2={axisBottom}
          stroke="var(--chart-ref)"
          strokeDasharray="3 4"
        />
        <text
          x={px(MEDIAN)}
          y={PAD.top - 14}
          textAnchor="middle"
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          cohort median
        </text>
        <text
          x={LABEL_W + TRACK_W + 12}
          y={PAD.top - 14}
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          spread of this dimension
        </text>
        <text
          x={LABEL_W + TRACK_W / 2}
          y={H - 6}
          textAnchor="middle"
          className="fill-[var(--color-muted)] text-[11px]"
        >
          Dimension score against own level →
        </text>

        {/* --- one row per dimension ------------------------------------------- */}
        {laidOut.map((row, i) => {
          const medX = row.med === null ? null : px(row.med)
          // Sized to the swarm rather than to the row, so the caps clear the dots by a
          // few pixels instead of floating in the gap between rows.
          const tickReach = row.maxLane * LANE_H + 13
          const tickTop = row.centre - tickReach
          const tickBottom = row.centre + tickReach
          return (
          <g key={row.key}>
            {i > 0 ? (
              <line
                x1={0}
                x2={W}
                y1={row.top}
                y2={row.top}
                stroke="var(--color-line)"
                strokeWidth={1}
                opacity={0.7}
              />
            ) : null}
            <text
              x={LABEL_W - 14}
              y={row.centre + 0.5}
              textAnchor="end"
              className="fill-[var(--color-ink)] text-[11px] font-medium"
            >
              {row.label}
            </text>
            <text
              x={LABEL_W - 14}
              y={row.centre + 11}
              textAnchor="end"
              className="tnum fill-[var(--color-muted)] text-[9px]"
            >
              {row.members.length} scored
            </text>

            {/* The row's own median: a capped tick, not a plain line. Two of these rows
                have a median of exactly 50, so an uncapped tick would vanish into the
                full-height 50 reference behind it, and the dots on top break the middle
                of it in any case. The caps sit in the row's clear air and read as one
                mark. */}
            {medX !== null && row.lo !== null && row.hi !== null ? (
              <>
                <line
                  x1={medX}
                  x2={medX}
                  y1={tickTop}
                  y2={tickBottom}
                  stroke="var(--chart-ref)"
                  strokeWidth={2}
                />
                {[tickTop, tickBottom].map((cap) => (
                  <line
                    key={cap}
                    x1={medX - 4}
                    x2={medX + 4}
                    y1={cap}
                    y2={cap}
                    stroke="var(--chart-ref)"
                    strokeWidth={2}
                  />
                ))}
                <text
                  x={LABEL_W + TRACK_W + 12}
                  y={row.centre - 2}
                  className="tnum fill-[var(--color-ink)] text-[10px] font-medium"
                >
                  {(row.hi - row.lo).toFixed(1)} pts wide
                </text>
                <text
                  x={LABEL_W + TRACK_W + 12}
                  y={row.centre + 9}
                  className="tnum fill-[var(--color-muted)] text-[9px]"
                >
                  {row.lo.toFixed(0)}–{row.hi.toFixed(0)} · median {row.med!.toFixed(1)}
                </text>
              </>
            ) : null}

            {row.members.map((m) => {
              const dim = active !== null && m.engineer.id !== active
              const cx = px(m.value)
              const cy = row.centre + m.lane * LANE_H
              const isActive = m.engineer.id === active
              const near = px(m.value) > LABEL_W + TRACK_W * 0.8
              return (
                <g key={m.engineer.id}>
                  <circle cx={cx} cy={cy} r={6.5} fill="var(--color-surface)" opacity={dim ? 0.4 : 1} />
                  {isActive ? (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={9.5}
                      fill="none"
                      stroke="var(--chart-series)"
                      strokeWidth={1.5}
                      opacity={0.55}
                    />
                  ) : null}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={4.5}
                    fill={m.engineer.solid ? 'var(--chart-series)' : 'var(--color-surface)'}
                    stroke="var(--chart-series)"
                    strokeWidth={m.engineer.solid ? 0 : 2}
                    opacity={dim ? 0.3 : 1}
                  />
                  {labelled.has(`${row.key}:${m.engineer.id}`) ? (
                    <text
                      x={near ? cx - 10 : cx + 10}
                      y={cy + 3.5}
                      textAnchor={near ? 'end' : 'start'}
                      className="fill-[var(--color-muted)] text-[9px]"
                      opacity={dim ? 0.4 : 1}
                    >
                      {m.engineer.shortName}
                    </text>
                  ) : null}
                  {/* A 24px transparent target: nobody reliably hits a 9px dot. */}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={12}
                    fill="transparent"
                    tabIndex={0}
                    role="button"
                    aria-label={`${m.engineer.name}, ${row.label} ${m.value.toFixed(1)}`}
                    className="cursor-pointer outline-none focus-visible:stroke-[var(--color-ink)]"
                    onMouseEnter={() => setActive(m.engineer.id)}
                    onMouseLeave={() => setActive((c) => (c === m.engineer.id ? null : c))}
                    onFocus={() => setActive(m.engineer.id)}
                    onBlur={() => setActive((c) => (c === m.engineer.id ? null : c))}
                  />
                </g>
              )
            })}
          </g>
          )
        })}
      </svg>

      {/* The readout is a strip under the chart, not a panel floating in it. Lighting
          one engineer lights all four of their dots, and a panel anywhere inside the
          plot covered two of the rows it was inviting a comparison across — which
          defeats the only thing hover adds here. */}
      <div className="mt-2 min-h-[2.5rem] border-t border-[var(--color-line)] pt-2">
        {hovered ? (
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
            <span className="font-semibold">{hovered.name}</span>
            <span className="text-[var(--color-muted)]">
              {hovered.level}
              {hovered.squad ? ` · ${hovered.squad}` : ''}
            </span>
            {DIMENSIONS.map((d) => (
              <span
                key={d.key}
                className={d.key === hoveredRow?.key ? '' : 'text-[var(--color-muted)]'}
              >
                {d.label} <span className="tnum font-semibold">{formatScore(hovered[d.key])}</span>
              </span>
            ))}
            {hovered.confidenceNote ? (
              <span className="text-[var(--color-muted)]">{hovered.confidenceNote}</span>
            ) : null}
          </p>
        ) : (
          <p className="text-[11px] text-[var(--color-muted)]">
            Hover or focus a dot to light that engineer in all four rows.
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-muted)]">
        <span>
          All four rows share one axis, so a wider row is genuinely a wider spread. The four count
          equally in the composite; they do not move people equally.
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="12" height="14" aria-hidden="true">
            <line x1="6" y1="2" x2="6" y2="12" stroke="var(--chart-ref)" strokeWidth="2" />
            <line x1="2.5" y1="2" x2="9.5" y2="2" stroke="var(--chart-ref)" strokeWidth="2" />
            <line x1="2.5" y1="12" x2="9.5" y2="12" stroke="var(--chart-ref)" strokeWidth="2" />
          </svg>
          Median of the row
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="12" height="14" aria-hidden="true">
            <line
              x1="6"
              y1="1"
              x2="6"
              y2="13"
              stroke="var(--chart-ref)"
              strokeDasharray="3 4"
            />
          </svg>
          50, the cohort median by construction
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
          Thin data or no cohort
        </span>
      </div>
    </div>
  )
}

function formatScore(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}
