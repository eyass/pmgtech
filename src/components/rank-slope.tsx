'use client'

import { useState } from 'react'

import { ConfidenceDot } from '@/components/confidence-dot'
import { levelSlot } from '@/lib/rank-bands'
import { confidenceMark, confidenceStates } from '@/lib/score-confidence'
import type { ScoreConfidence } from '@/lib/types/performance'

/**
 * How much of a placing is the engineer and how much is the job title.
 *
 * Two columns, one line each. On the left, where someone sits in the org-wide
 * ranking; on the right, where they sit among the people they are actually scored
 * against. A line sloping down means the org ranking flatters them relative to
 * their own level — they are above the org's middle largely because the level is;
 * a line sloping up means they are strong *for their level* and the org ranking is
 * charging them for being junior. A flat line means the two readings agree, which
 * is the useful null: it says seniority is not distorting the placing.
 *
 * `engineer_outliers` already returns both numbers, `rank_in_org` and
 * `rank_at_level`, so this is a view of data the page has and does not show.
 *
 * Two decisions that are worth arguing about, both taken the honest way:
 *
 * 1. **The right column is stretched to each cohort's size, not drawn as a raw
 *    rank.** Last of five mids and sixth of nine seniors are not the same placing,
 *    but 5 draws above 6, so a shared raw axis would put the worse placing higher.
 *    `levelSlot` maps each cohort's ranks across the full column instead, so the top
 *    of the axis means "best at my level" for everybody. That is why the right axis
 *    has no numbers on it — a tick reading "7" would be true for a nine-person
 *    cohort and a lie for a five-person one. The exact placing (`#4 of 9`) is on
 *    every row's readout and in the ranked table.
 * 2. **Both axes invert**, 1 at the top, because a rank is a position and everyone
 *    reads first place as up. The left axis keeps its numbers, since org rank is
 *    one scale for everybody.
 *
 * Someone who is the only person at their level is not drawn. A level rank of 1 of 1
 * is not a placing, and putting them at the top of the column would read as the
 * strongest engineer in the org. The count is stated under the chart instead.
 */

export type RankSlopeRow = {
  id: string
  name: string
  /** Used for the direct labels, where a full name would collide with the column. */
  shortName: string
  /** `rank_in_org`. Dense, so ties share a number. */
  rankInOrg: number
  /** `rank_at_level`, read against `peersAtLevel` rather than against the org. */
  rankAtLevel: number
  /** `peers_at_level`. Below two there is no placing and the row is dropped. */
  peersAtLevel: number
  level: string
  squad: string | null
  score: number | null
  /**
   * The flag itself, not a boolean: `partial_window` draws differently from thin
   * data because it means something different. See `score-confidence.ts`.
   */
  confidence: ScoreConfidence
  confidenceNote: string | null
}

const PAD = { top: 42, bottom: 30 }
const COL_L = 176
const COL_R = 470
const W = 640
const ROW_STEP = 30
/** Dot radius plus its surface ring: closer than this and two dots are one mark. */
const TOUCHING = 13

export function RankSlope({ rows }: { rows: RankSlopeRow[] }) {
  const [active, setActive] = useState<string | null>(null)

  const span = Math.max(...rows.map((r) => r.rankInOrg), 1)
  const placed = rows
    .map((r) => ({ ...r, slot: levelSlot(r.rankAtLevel, r.peersAtLevel, span) }))
    .filter((r): r is RankSlopeRow & { slot: number } => r.slot !== null)
    .sort((a, b) => a.rankInOrg - b.rankInOrg)
  const dropped = rows.length - placed.length

  if (placed.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--color-muted)]">
        Everybody scored in this period is the only person at their level, so there is no rank at
        level to compare an org rank against.
      </p>
    )
  }

  const trackTop = PAD.top
  const trackBottom = PAD.top + (span - 1) * ROW_STEP
  const H = trackBottom + PAD.bottom
  const y = (rank: number) => trackTop + ((rank - 1) / Math.max(span - 1, 1)) * (trackBottom - trackTop)

  // Direct labels go to the biggest movers — the whole point of the chart — and the
  // candidates are chosen before the crowding filter runs, so a name dropped for
  // being crowded is simply not drawn. Nothing is promoted in its place; backfilling
  // would put names on the engineers whose two ranks agree, which is the one thing
  // this chart has nothing to say about.
  //
  // The two ends are filtered independently, because they crowd differently: the org
  // column has one dot per rank, while the level column stacks everyone who tops a
  // cohort onto the same slot. Requiring both ends to be clear before naming either
  // left this chart with one label out of fourteen. So a name goes on the left end
  // when the left end is unambiguous, and the exact placing goes on the right end when
  // the right end is — never both from one test.
  const candidates = [...placed]
    .sort((a, b) => Math.abs(b.slot - b.rankInOrg) - Math.abs(a.slot - a.rankInOrg))
    .slice(0, 8)
    .filter((p) => Math.abs(p.slot - p.rankInOrg) >= 0.75) // a flat line has no end to name
  const labelEnd = (at: (r: (typeof placed)[number]) => number) => {
    const out = new Set<string>()
    for (const p of candidates) {
      const crowded = placed.some((q) => q.id !== p.id && Math.abs(at(q) - at(p)) < TOUCHING)
      if (crowded) continue
      const collides = [...out].some((id) => {
        const q = placed.find((c) => c.id === id)!
        return Math.abs(at(q) - at(p)) < 22
      })
      if (collides) continue
      out.add(p.id)
    }
    return out
  }
  const labelledLeft = labelEnd((r) => y(r.rankInOrg))
  const labelledRight = labelEnd((r) => y(r.slot))

  const hovered = placed.find((p) => p.id === active) ?? null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Rank in org against rank at level for ${placed.length} engineers`}
      >
        {/* --- the two columns ------------------------------------------------- */}
        <line x1={COL_L} x2={COL_L} y1={trackTop - 12} y2={trackBottom + 12} stroke="var(--chart-axis)" />
        <line x1={COL_R} x2={COL_R} y1={trackTop - 12} y2={trackBottom + 12} stroke="var(--chart-axis)" />
        <text
          x={COL_L}
          y={trackTop - 24}
          textAnchor="middle"
          className="fill-[var(--color-ink)] text-[11px] font-medium"
        >
          Rank in org
        </text>
        <text
          x={COL_R}
          y={trackTop - 24}
          textAnchor="middle"
          className="fill-[var(--color-ink)] text-[11px] font-medium"
        >
          Rank at own level
        </text>
        <text
          x={COL_L}
          y={trackTop - 14}
          textAnchor="middle"
          className="tnum fill-[var(--color-muted)] text-[9px]"
        >
          1 of {span}, all levels together
        </text>
        <text x={COL_R} y={trackTop - 14} textAnchor="middle" className="fill-[var(--color-muted)] text-[9px]">
          stretched to each cohort&apos;s size
        </text>

        {/* Every org rank is numbered — it is one scale for everybody, so the column
            can be read straight off. A rank with no dot beside it is a rank the dense
            ordering skipped because two people tied above it. The right column is
            deliberately unnumbered: a tick reading 7 would be true for a nine-person
            cohort and false for a five-person one. */}
        {Array.from({ length: span }, (_, i) => i + 1).map((r) => (
          <text
            key={r}
            x={COL_L - 16}
            y={y(r) + 3.5}
            textAnchor="end"
            className="tnum fill-[var(--color-muted)] text-[10px]"
          >
            {r}
          </text>
        ))}
        <text
          x={COL_R + 84}
          y={trackTop - 2}
          textAnchor="start"
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          best at level
        </text>
        <text
          x={COL_R + 84}
          y={trackBottom + 10}
          textAnchor="start"
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          last at level
        </text>

        {/* --- one line per engineer ------------------------------------------- */}
        {placed.map((p) => {
          const dim = active !== null && p.id !== active
          const y1 = y(p.rankInOrg)
          const y2 = y(p.slot)
          return (
            <g key={p.id}>
              <line
                x1={COL_L}
                x2={COL_R}
                y1={y1}
                y2={y2}
                stroke="var(--chart-series)"
                strokeWidth={p.id === active ? 2.25 : 1.25}
                opacity={dim ? 0.22 : p.id === active ? 1 : 0.7}
              />
              {[
                { cx: COL_L, cy: y1 },
                { cx: COL_R, cy: y2 },
              ].map((end, i) => (
                <g key={i}>
                  <circle cx={end.cx} cy={end.cy} r={6} fill="var(--color-surface)" opacity={dim ? 0.4 : 1} />
                  {p.id === active ? (
                    <circle
                      cx={end.cx}
                      cy={end.cy}
                      r={9}
                      fill="none"
                      stroke="var(--chart-series)"
                      strokeWidth={1.5}
                      opacity={0.55}
                    />
                  ) : null}
                  <ConfidenceDot
                    cx={end.cx}
                    cy={end.cy}
                    r={5}
                    mark={confidenceMark(p.confidence)}
                    opacity={dim ? 0.35 : 1}
                  />
                </g>
              ))}
              {labelledLeft.has(p.id) ? (
                <text
                  x={COL_L - 34}
                  y={y1 + 3.5}
                  textAnchor="end"
                  className="fill-[var(--color-muted)] text-[10px]"
                  opacity={dim ? 0.4 : 1}
                >
                  {p.shortName}
                </text>
              ) : null}
              {labelledRight.has(p.id) ? (
                <text
                  x={COL_R + 12}
                  y={y2 + 3.5}
                  className="tnum fill-[var(--color-muted)] text-[10px]"
                  opacity={dim ? 0.4 : 1}
                >
                  #{p.rankAtLevel} of {p.peersAtLevel}
                </text>
              ) : null}

              {/* The target is the whole line, 16px thick and transparent, rather than
                  its ends. Two engineers tied on org rank share the left dot exactly —
                  it happens in this org's real data — and an end-only target would
                  leave one of the two lines unreachable by mouse and by keyboard
                  alike. Their lines diverge, so a line target always has a stretch
                  that belongs to one of them. One tab stop per engineer. */}
              <line
                x1={COL_L}
                x2={COL_R}
                y1={y1}
                y2={y2}
                stroke="transparent"
                strokeWidth={16}
                tabIndex={0}
                role="button"
                aria-label={`${p.name}, ${p.level}, rank ${p.rankInOrg} of ${span} in org, rank ${p.rankAtLevel} of ${p.peersAtLevel} at level`}
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

      {/* The readout goes under the chart, not over it. Every line crosses the middle
          of the plot, so a floating panel there would hide the neighbours a slope only
          means anything against. */}
      <div className="mt-2 min-h-[2.5rem] border-t border-[var(--color-line)] pt-2">
        {hovered ? (
          <p className="text-[11px] leading-relaxed">
            <span className="font-semibold">{hovered.name}</span>
            <span className="text-[var(--color-muted)]">
              {' · '}
              {hovered.level}
              {hovered.squad ? ` · ${hovered.squad}` : ''}
              {hovered.score !== null ? ` · ${hovered.score.toFixed(1)}` : ''} ·{' '}
              <span className="tnum">
                #{hovered.rankInOrg} of {span} in org
              </span>
              {' · '}
              <span className="tnum">
                #{hovered.rankAtLevel} of {hovered.peersAtLevel} at level
              </span>
              {' — '}
              {describeSlope(hovered.slot - hovered.rankInOrg)}
              {hovered.confidenceNote ? ` ${hovered.confidenceNote}.` : ''}
            </span>
          </p>
        ) : (
          <p className="text-[11px] text-[var(--color-muted)]">
            Hover or focus a line to read both of its ranks.
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-muted)]">
        <span>
          Down the page is <strong>worse than the org ranking implies</strong> for their level, up
          the page is better. Flat means seniority is not moving the placing.
        </span>
        {confidenceStates(rows.map((r) => r.confidence)).map((state) => (
          <span key={state.confidence} className="flex items-center gap-1.5">
            <svg width="13" height="13" aria-hidden="true">
              <ConfidenceDot cx={6.5} cy={6.5} r={5} mark={state.mark} />
            </svg>
            {state.meaning} ({state.count})
          </span>
        ))}
        {dropped > 0 ? (
          <span>
            {dropped} {dropped === 1 ? 'engineer is' : 'engineers are'} not drawn: they are the only
            person at their level, and 1 of 1 is not a placing.
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** Slope in org-rank units, so a whole rank of movement is 1. */
function describeSlope(delta: number): string {
  if (delta <= -2) return 'Ranks well above the org placing among their own level — strong for their level.'
  if (delta <= -0.75) return 'Slightly stronger against their own level than against the org.'
  if (delta < 0.75) return 'The two readings agree: the org placing is not coming from their level.'
  if (delta < 2) return 'Slightly weaker against their own level than against the org.'
  return 'Sits well below the org placing among their own level — the org ranking is flattering the level, not the engineer.'
}
