'use client'

import { useState } from 'react'

import { MEDIAN, scoreDomain, ticksIn } from '@/lib/chart-scale'
import { MATERIAL_SCORE_GAP, tieBands } from '@/lib/rank-bands'
import type { Standing } from '@/lib/types/performance'

/**
 * The ranking with its own precision drawn on top of it.
 *
 * Every engineer on one vertical axis, ordered by composite score, one dot at the
 * score. The ordering is the same one the ranked table shows; what the table cannot
 * show is that most of its rank numbers are not differences. This org's fourteen
 * scored engineers occupy 45 points, and eleven of them occupy 6.6 — the table
 * prints those eleven as ranks 3 to 13, eleven distinct placings, when the whole
 * spread is under half of one interquartile range. Two of them are already tied on
 * the same score and the table has to give them a shared number; the rows around
 * them are tied in every sense that matters and get separate numbers anyway.
 *
 * **The tie band is the chart.** A shaded box is the bounding region of a group of
 * engineers whose scores are not materially apart, so its width is the group's
 * entire spread and its height is how many rank numbers that spread was split into.
 *
 * The rule, and where it comes from — nothing here is a new threshold:
 *
 * - `MATERIAL_SCORE_GAP` is **15 points, one interquartile range of a seniority
 *   cohort**. `score_vs_cohort` in `0021_outliers.sql` is constructed so that ±1
 *   IQR is ±15 points around 50, and `0018_material_performance_bands.sql` already
 *   refuses to call a metric 'above' or 'below' until it clears an absolute
 *   materiality gate — the whole point of that migration was that `percent_rank`
 *   manufactures a top and a bottom out of a four-hour spread. The composite score
 *   inherited the ranking but never the gate. This applies the same gate to it.
 * - Groups are built greedily from the top, so every member of a band is within one
 *   IQR of the band's *leader* and therefore of each other. A band is a claim that
 *   those people are indistinguishable, and it holds for every pair inside it.
 * - What a band edge is **not** is a claim of difference. Two engineers either side
 *   of one can be closer than two inside a band — here 57.6 and 53.5 fall in
 *   different bands while 53.5 and 46.9 share one. The shading is a lower bound on
 *   how much of the ranking is noise, which is the safe direction to err in.
 * - The table's own `Gap` read is printed beside each score as corroboration, from
 *   the 0018 tally that already ships: `even` means not one of that engineer's
 *   dimensions cleared its materiality gate in either direction.
 *
 * Score, rank and gap are drawn as text on every row, so the hover layer adds
 * nothing that is not already legible — the ranked table stays the twin, and this
 * stays readable printed.
 */

export type RankDotPlotRow = {
  id: string
  /** Drawn in full in the left gutter — this chart never needs a short form. */
  name: string
  /** Composite 0-100 against the engineer's own seniority cohort. Null drops out. */
  score: number | null
  /** `rank_in_org`, shown greyed because the band behind it is the honest version. */
  rank: number
  level: string
  squad: string | null
  /** False for thin data or no cohort — drawn hollow rather than in another colour. */
  solid: boolean
  confidenceNote: string | null
  /** From the 0018 materiality tally, carried through `engineer_outliers`. */
  standing: Standing
  net: number
}

// The label column has to hold a full name over "Senior Engineer · Team Monetization"
// without clipping; the right column has to hold the band annotation without
// clipping. Both were measured against the real names rather than guessed.
const LABEL_W = 212
const TRACK_W = 392
const VALUE_W = 228
const ROW_H = 26
const PAD = { top: 46, bottom: 34 }
const W = LABEL_W + TRACK_W + VALUE_W
const SCORE_X = LABEL_W + TRACK_W + 12
const GAP_X = LABEL_W + TRACK_W + 56
const BRACE_X = LABEL_W + TRACK_W + 106

/** Matches `GapPill` on the Outliers table, so the two never disagree in wording. */
function gapText(standing: Standing, net: number): string {
  if (standing === 'top') return `+${net} real`
  if (standing === 'bottom') return `${net} real`
  if (standing === 'unread') return 'no read'
  return 'even'
}

export function RankDotPlot({ rows }: { rows: RankDotPlotRow[] }) {
  const [active, setActive] = useState<string | null>(null)

  const scored = rows
    .filter((r): r is RankDotPlotRow & { score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.rank - b.rank)

  if (scored.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--color-muted)]">
        Nobody has a composite score in this period.
      </p>
    )
  }

  const domain = scoreDomain(scored.map((r) => r.score))
  const px = (v: number) => LABEL_W + ((v - domain[0]) / (domain[1] - domain[0])) * TRACK_W
  const rowY = (i: number) => PAD.top + i * ROW_H + ROW_H / 2
  const H = PAD.top + scored.length * ROW_H + PAD.bottom
  const axisBottom = PAD.top + scored.length * ROW_H

  // Rows are sorted by score and the bands are built from the same order, so a band
  // is always a contiguous run of rows and can be drawn as one box.
  const boxes = tieBands(scored).map((band) => {
    const indices = band.ids.map((id) => scored.findIndex((r) => r.id === id))
    return { ...band, first: Math.min(...indices), last: Math.max(...indices) }
  })
  const bandOf = new Map<string, (typeof boxes)[number]>()
  for (const box of boxes) for (const id of box.ids) bandOf.set(id, box)

  const hovered = scored.find((r) => r.id === active) ?? null
  const tiedCount = boxes.filter((b) => b.ids.length > 1).reduce((n, b) => n + b.ids.length, 0)

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${scored.length} engineers by composite score, falling into ${boxes.length} groups that are not materially apart`}
      >
        {/* --- the rule, drawn to scale so it needs no arithmetic ------------- */}
        <g>
          <line x1={LABEL_W} x2={px(domain[0] + MATERIAL_SCORE_GAP)} y1={15} y2={15} stroke="var(--chart-ref)" />
          <line x1={LABEL_W} x2={LABEL_W} y1={11} y2={19} stroke="var(--chart-ref)" />
          <line
            x1={px(domain[0] + MATERIAL_SCORE_GAP)}
            x2={px(domain[0] + MATERIAL_SCORE_GAP)}
            y1={11}
            y2={19}
            stroke="var(--chart-ref)"
          />
          <text
            x={px(domain[0] + MATERIAL_SCORE_GAP) + 8}
            y={18}
            className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
          >
            {MATERIAL_SCORE_GAP} pts — one interquartile range
          </text>
        </g>

        {/* --- grid ---------------------------------------------------------- */}
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
        <line x1={px(MEDIAN)} x2={px(MEDIAN)} y1={PAD.top - 8} y2={axisBottom} stroke="var(--chart-ref)" />
        <text
          x={px(MEDIAN)}
          y={PAD.top - 13}
          textAnchor="middle"
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          cohort median
        </text>
        <text x={SCORE_X} y={PAD.top - 13} className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide">
          score
        </text>
        <text x={GAP_X} y={PAD.top - 13} className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide">
          gap
        </text>
        <text
          x={LABEL_W + TRACK_W / 2}
          y={H - 6}
          textAnchor="middle"
          className="fill-[var(--color-muted)] text-[11px]"
        >
          Composite score against own level →
        </text>

        {/* --- the tie bands ------------------------------------------------- */}
        {boxes.map((box) => {
          const top = rowY(box.first) - ROW_H / 2 + 2
          const bottom = rowY(box.last) + ROW_H / 2 - 2
          const mid = (top + bottom) / 2
          const tied = box.ids.length > 1
          return (
            <g key={box.index}>
              {tied ? (
                <>
                  <rect
                    x={px(box.bottom) - 10}
                    y={top}
                    width={px(box.top) - px(box.bottom) + 20}
                    height={bottom - top}
                    rx={5}
                    fill="var(--chart-ref)"
                    opacity={0.15}
                  />
                  <rect
                    x={px(box.bottom) - 10}
                    y={top}
                    width={px(box.top) - px(box.bottom) + 20}
                    height={bottom - top}
                    rx={5}
                    fill="none"
                    stroke="var(--chart-ref)"
                    opacity={0.6}
                  />
                </>
              ) : null}
              {/* A brace in the margin, so the grouping survives the box being narrow. */}
              <path
                d={`M ${BRACE_X + 5} ${top} L ${BRACE_X} ${top} L ${BRACE_X} ${bottom} L ${BRACE_X + 5} ${bottom}`}
                fill="none"
                stroke="var(--chart-ref)"
                opacity={tied ? 0.85 : 0.45}
              />
              <text x={BRACE_X + 11} y={mid - 2} className="fill-[var(--color-ink)] text-[10px] font-medium">
                {tied ? `${box.ids.length} not separable` : 'separated'}
              </text>
              <text x={BRACE_X + 11} y={mid + 9} className="tnum fill-[var(--color-muted)] text-[9px]">
                {tied
                  ? `${(box.top - box.bottom).toFixed(1)} pts, ${box.ids.length} rank numbers`
                  : 'clears a full IQR'}
              </text>
            </g>
          )
        })}

        {/* --- one row per engineer ------------------------------------------ */}
        {scored.map((row, i) => {
          const dim = active !== null && row.id !== active
          const cy = rowY(i)
          return (
            <g key={row.id}>
              {/* Rank right-aligned, name left-aligned beside it — the table reading.
                  Right-aligning the names too left the rank numbers stranded in their
                  own gutter, a whole column away from the row they belong to. */}
              <text
                x={26}
                y={cy + 3.5}
                textAnchor="end"
                className="tnum fill-[var(--color-muted)] text-[10px]"
                opacity={dim ? 0.45 : 1}
              >
                {row.rank}
              </text>
              <text
                x={38}
                y={cy + 0.5}
                className="fill-[var(--color-ink)] text-[11px]"
                opacity={dim ? 0.45 : 1}
              >
                {row.name}
              </text>
              <text
                x={38}
                y={cy + 10}
                className="fill-[var(--color-muted)] text-[9px]"
                opacity={dim ? 0.45 : 1}
              >
                {row.level}
                {row.squad ? ` · ${row.squad}` : ''}
              </text>

              {/* 2px surface ring first, so a dot on a band edge stays countable. */}
              <circle cx={px(row.score)} cy={cy} r={6.5} fill="var(--color-surface)" opacity={dim ? 0.4 : 1} />
              {row.id === active ? (
                <circle
                  cx={px(row.score)}
                  cy={cy}
                  r={9.5}
                  fill="none"
                  stroke="var(--chart-series)"
                  strokeWidth={1.5}
                  opacity={0.55}
                />
              ) : null}
              <circle
                cx={px(row.score)}
                cy={cy}
                r={4.5}
                fill={row.solid ? 'var(--chart-series)' : 'var(--color-surface)'}
                stroke="var(--chart-series)"
                strokeWidth={row.solid ? 0 : 2}
                opacity={dim ? 0.35 : 1}
              />

              {/* Values as text: the chart has to be readable without a pointer. */}
              <text
                x={SCORE_X}
                y={cy + 3.5}
                className="tnum fill-[var(--color-ink)] text-[10px] font-medium"
                opacity={dim ? 0.45 : 1}
              >
                {row.score.toFixed(1)}
              </text>
              <text
                x={GAP_X}
                y={cy + 3.5}
                className="tnum fill-[var(--color-muted)] text-[9px]"
                opacity={dim ? 0.45 : 1}
              >
                {gapText(row.standing, row.net)}
              </text>

              {/* A 26px transparent row target: nobody reliably hits a 9px dot. */}
              <rect
                x={0}
                y={cy - 13}
                width={BRACE_X - 6}
                height={26}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${row.name}, ${row.level}, rank ${row.rank} in org, score ${row.score.toFixed(1)}, gap ${gapText(row.standing, row.net)}`}
                className="cursor-pointer outline-none focus-visible:stroke-[var(--color-ink)]"
                onMouseEnter={() => setActive(row.id)}
                onMouseLeave={() => setActive((c) => (c === row.id ? null : c))}
                onFocus={() => setActive(row.id)}
                onBlur={() => setActive((c) => (c === row.id ? null : c))}
              />
            </g>
          )
        })}
      </svg>

      {/* The readout sits under the chart rather than floating over it. A tooltip
          pinned to the hovered row covered the rows either side of it — the ones the
          tie band is a statement about — which is the one thing this chart must not
          hide. Nothing here is load-bearing anyway: score, rank and gap are already
          drawn on the row, and this adds the sentence the shading is making. */}
      <div className="mt-2 min-h-[2.5rem] border-t border-[var(--color-line)] pt-2">
        {hovered ? (
          <p className="text-[11px] leading-relaxed">
            <span className="font-semibold">{hovered.name}</span>
            <span className="text-[var(--color-muted)]">
              {' · '}
              {hovered.level}
              {hovered.squad ? ` · ${hovered.squad}` : ''} · #{hovered.rank} in org ·{' '}
              <span className="tnum">{hovered.score.toFixed(1)}</span> · gap{' '}
              {gapText(hovered.standing, hovered.net)}
              {' — '}
              {describeBand((bandOf.get(hovered.id)?.ids.length ?? 1) - 1)}
              {hovered.confidenceNote ? ` ${hovered.confidenceNote}.` : ''}
            </span>
          </p>
        ) : (
          <p className="text-[11px] text-[var(--color-muted)]">
            Hover or focus a row to read what its rank number is worth.
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-muted)]">
        <span className="flex items-center gap-1.5">
          <svg width="14" height="12" aria-hidden="true">
            <rect
              x="0.5"
              y="1.5"
              width="13"
              height="9"
              rx="2"
              fill="var(--chart-ref)"
              fillOpacity="0.15"
              stroke="var(--chart-ref)"
              strokeOpacity="0.6"
            />
          </svg>
          Not materially apart — {tiedCount} of {scored.length} hold a rank number that is not a
          difference
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

/** What sharing a band means, for however many people share it. */
function describeBand(others: number): string {
  if (others < 1) {
    return 'more than one interquartile range from everybody else, so this placing is a real one.'
  }
  const who = others === 1 ? 'one other engineer' : `${others} others`
  return `inside one interquartile range of ${who}, so the rank numbers between them are not differences.`
}
