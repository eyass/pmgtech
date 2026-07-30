'use client'

import { useState } from 'react'

import { MEDIAN, scoreDomain, ticksIn } from '@/lib/chart-scale'
import { MIN_COHORT } from '@/lib/trust'

/**
 * How tightly each seniority cohort is bunched, and who sits outside their own.
 *
 * The scatter answers "which direction is this person off in"; this answers the
 * question underneath the whole page — **is the ranking separating anybody at
 * all.** One row per level, one dot per engineer, and the median line running
 * through every row at 50.
 *
 * Two things make it worth its space rather than being a prettier ranking:
 *
 * - **It is the score's own integrity check.** An engineer's score is built so
 *   that 50 is the median of their level. So each row's dots *must* straddle the
 *   line with roughly half either side. A row sitting entirely on one side is not
 *   a strong or weak cohort — it is a bug in the scoring or a cohort too small to
 *   have a median, and this is the only view on the page where that shows up.
 * - **Bunching is the finding.** With this org's data most engineers land inside
 *   one interquartile range of their cohort, so the honest picture is a tight
 *   cluster with one or two genuinely separated dots — not an even spread from
 *   first to last. A table of ranks cannot show that; a strip plot shows nothing
 *   else.
 *
 * Every score here is also in the ranked table below, so hover adds names rather
 * than being the only way to read a value.
 */

export type CohortMember = {
  id: string
  name: string
  score: number
  /** False for thin data or no cohort — hollow, never a second colour. */
  solid: boolean
  note: string | null
}

export type Cohort = {
  key: string
  label: string
  members: CohortMember[]
}

const LABEL_W = 132
const TRACK_W = 470
const ROW_H = 34
const PAD = { top: 26, bottom: 34, right: 16 }
const W = LABEL_W + TRACK_W + PAD.right

export function CohortStrip({ cohorts }: { cohorts: Cohort[] }) {
  const [active, setActive] = useState<string | null>(null)

  const all = cohorts.flatMap((c) => c.members)
  if (all.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--color-muted)]">
        Nobody is scored in this period.
      </p>
    )
  }

  const domain = scoreDomain(all.map((m) => m.score))
  const px = (v: number) => LABEL_W + ((v - domain[0]) / (domain[1] - domain[0])) * TRACK_W
  const H = PAD.top + cohorts.length * ROW_H + PAD.bottom

  const hovered = all.find((m) => m.id === active) ?? null
  const hoveredRow = cohorts.findIndex((c) => c.members.some((m) => m.id === active))

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Score distribution across ${cohorts.length} seniority cohorts`}
      >
        {/* --- grid and the median --------------------------------------------- */}
        {ticksIn(domain).map((t) => (
          <g key={t}>
            <line
              x1={px(t)}
              x2={px(t)}
              y1={PAD.top - 6}
              y2={PAD.top + cohorts.length * ROW_H}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={px(t)}
              y={PAD.top + cohorts.length * ROW_H + 16}
              textAnchor="middle"
              className="tnum fill-[var(--color-muted)] text-[10px]"
            >
              {t}
            </text>
          </g>
        ))}
        <line
          x1={px(MEDIAN)}
          x2={px(MEDIAN)}
          y1={PAD.top - 6}
          y2={PAD.top + cohorts.length * ROW_H}
          stroke="var(--chart-ref)"
          strokeWidth={1}
        />
        <text
          x={px(MEDIAN)}
          y={PAD.top - 12}
          textAnchor="middle"
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          cohort median
        </text>

        {/* --- one row per level ----------------------------------------------- */}
        {cohorts.map((cohort, row) => {
          const cy = PAD.top + row * ROW_H + ROW_H / 2
          // A median needs somebody to be the middle of; below three there isn't one.
          const thin = cohort.members.length < MIN_COHORT
          return (
            <g key={cohort.key}>
              <line
                x1={LABEL_W}
                x2={LABEL_W + TRACK_W}
                y1={cy}
                y2={cy}
                stroke="var(--chart-grid)"
                strokeWidth={1}
                opacity={0.7}
              />
              <text
                x={LABEL_W - 10}
                y={cy - 2}
                textAnchor="end"
                className="fill-[var(--color-ink)] text-[11px]"
              >
                {cohort.label}
              </text>
              <text
                x={LABEL_W - 10}
                y={cy + 10}
                textAnchor="end"
                className="fill-[var(--color-muted)] text-[9px]"
              >
                {cohort.members.length}
                {thin ? ' · no median' : ''}
              </text>
              {cohort.members.map((m) => {
                const dim = active !== null && m.id !== active
                return (
                  <g key={m.id}>
                    <circle cx={px(m.score)} cy={cy} r={6.5} fill="var(--color-surface)" />
                    {m.id === active ? (
                      <circle
                        cx={px(m.score)}
                        cy={cy}
                        r={9.5}
                        fill="none"
                        stroke="var(--chart-series)"
                        strokeWidth={1.5}
                        opacity={0.55}
                      />
                    ) : null}
                    <circle
                      cx={px(m.score)}
                      cy={cy}
                      r={4.5}
                      fill={m.solid ? 'var(--chart-series)' : 'var(--color-surface)'}
                      stroke="var(--chart-series)"
                      strokeWidth={m.solid ? 0 : 2}
                      opacity={dim ? 0.35 : 1}
                    />
                    <circle
                      cx={px(m.score)}
                      cy={cy}
                      r={13}
                      fill="transparent"
                      tabIndex={0}
                      role="button"
                      aria-label={`${m.name}, ${cohort.label}, score ${m.score.toFixed(1)}`}
                      className="cursor-pointer outline-none focus-visible:stroke-[var(--color-ink)]"
                      onMouseEnter={() => setActive(m.id)}
                      onMouseLeave={() => setActive((c) => (c === m.id ? null : c))}
                      onFocus={() => setActive(m.id)}
                      onBlur={() => setActive((c) => (c === m.id ? null : c))}
                    />
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>

      {hovered ? (
        <div
          className="pointer-events-none absolute z-10 w-52 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5 shadow-lg"
          style={{
            left: `${(px(hovered.score) / W) * 100}%`,
            top: `${((PAD.top + hoveredRow * ROW_H + ROW_H / 2) / H) * 100}%`,
            transform: `translate(${px(hovered.score) > W * 0.6 ? 'calc(-100% - 14px)' : '14px'}, -50%)`,
          }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs font-semibold">{hovered.name}</p>
            <p className="tnum text-xs font-semibold">{hovered.score.toFixed(1)}</p>
          </div>
          {hovered.note ? (
            <p className="mt-1.5 text-[10px] text-[var(--color-muted)]">{hovered.note}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
