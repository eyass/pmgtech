'use client'

import { useState, type Dispatch, type SetStateAction } from 'react'

import { ConfidenceDot } from '@/components/confidence-dot'
import { MetricNote } from '@/components/ui'
import {
  absoluteDomain,
  fractionIn,
  measured,
  MEDIAN,
  scoreDomain,
  TARGET_MIDPOINT,
  ticksIn,
} from '@/lib/chart-scale'
import { confidenceMark, isSolidMark } from '@/lib/score-confidence'
import type { ScoreConfidence } from '@/lib/types/performance'

/**
 * Whether a squad is uniformly strong or carried by one person.
 *
 * The squad ranking hides exactly this. A squad's score is built from squad-level
 * rates — merge requests per engineer per week, cycle time, review coverage — and
 * an average has no memory of whether four people each did a quarter of it or one
 * person did most of it. So this puts one row per squad, one dot per member placed
 * at that member's own composite score, with the range between the lowest and the
 * highest drawn behind them. A tight knot is a squad where the score describes
 * everybody; a long row with one dot out on its own is a squad where it describes
 * nobody.
 *
 * ## The two scores are not on the same scale, and are not put on one axis
 *
 * An engineer's score is **relative**: 0-100 against the median of their own
 * seniority cohort, where 50 means "half your level is either side of you". A
 * squad's score is **absolute**: 0-100 between a bad threshold and a good one,
 * where 50 means "halfway to the target" and nobody has to be near it. The two
 * numbers are not comparable in either direction, and one shared axis would invite
 * the worst available reading — DevExp scores 74.7 against targets while its two
 * engineers sit at 50.8 and 47.3 against their cohort, which on one axis looks like
 * a squad outperforming its own members, a sentence that means nothing.
 *
 * So they are drawn as **two scales, side by side, separated by a rule**, each with
 * its own heading and its own reference mark: a short fixed 0-100 target track with
 * a diamond for the squad, and a cropped cohort strip with circles for the members.
 * Different scale, different mark, different track, said out loud in the heading.
 * The alternative — members only, squad score as a bare number — is honest too, but
 * it throws away the comparison across rows that makes the squad column worth
 * having at all.
 *
 * A member with no composite score is counted in the left column, never placed at
 * 0; the same for a squad with no score of its own.
 */

export type SquadCompositionMember = {
  id: string
  name: string
  /** 0-100 against their own seniority cohort. 50 is the cohort median. Null when unscored. */
  score: number | null
  level: string
  /**
   * The flag itself: a member who was here for part of the period draws as a half
   * dot, not as the hollow one that means thin data. See `score-confidence.ts`.
   */
  confidence: ScoreConfidence
  note: string | null
}

export type SquadCompositionRow = {
  key: string
  name: string
  /**
   * 0-100 against absolute targets. **Not** the same scale as the member scores,
   * and never drawn on the same axis as them.
   */
  squadScore: number | null
  /** Engineers in the squad's metrics. */
  headcount: number
  /** False for thin confidence — hollow diamond, never a second colour. */
  solid: boolean
  members: SquadCompositionMember[]
}

export type SquadCompositionProps = { rows: SquadCompositionRow[] }

const TARGET_W = 112
const TARGET_H = 20
const DIAMOND_R = 5.5

const STRIP_W = 440
const STRIP_CY = 16
const DOT_R = 4.5
/** Rows where a dot gets a name are taller, so the name has somewhere to go. */
const STRIP_H = { bare: 32, named: 46 }
/** Lanes a dot can sit in when its neighbour is too close to stay countable. */
const LANES = [0, -8, 8]

export function SquadComposition({ rows }: SquadCompositionProps) {
  const [active, setActive] = useState<string | null>(null)

  const members = rows.flatMap((r) => r.members)
  const scores = members.flatMap((m) => {
    const value = measured(m.score)
    return value === null ? [] : [value]
  })

  if (rows.length === 0 || scores.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--color-muted)]">
        No squad has a scored member in this period.
      </p>
    )
  }

  // The member strip is an engineer scale, so it takes the engineer rule: never
  // tighter than 40 points, always containing the cohort median.
  const cohort = scoreDomain(scores)
  const mx = (v: number) => DOT_R + fractionIn(v, cohort) * (STRIP_W - DOT_R * 2)
  const hovered = members.find((m) => m.id === active) ?? null

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse">
          <thead>
            <tr className="align-bottom">
              <th className="pb-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                Squad
              </th>
              <th className="border-r border-[var(--color-line)] pb-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                Squad vs absolute targets
                <span className="mt-0.5 block font-normal normal-case tracking-normal">
                  Fixed 0-100 · 50 is halfway to the target
                </span>
              </th>
              <th className="pb-2 pl-4 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                Members vs their own seniority cohort
                <span className="mt-0.5 block font-normal normal-case tracking-normal">
                  A different scale · 50 is the cohort median
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-[var(--color-line)] align-top">
                <td className="py-3 pr-4">
                  <span className="block text-xs font-medium">{row.name}</span>
                  <span className="tnum block text-[10px] text-[var(--color-muted)]">
                    {row.headcount} in metrics
                  </span>
                  <SpreadNote members={row.members} />
                </td>
                <td className="border-r border-[var(--color-line)] py-3 pr-4">
                  <TargetTrack score={row.squadScore} solid={row.solid} name={row.name} />
                </td>
                <td className="py-3 pl-4">
                  <MemberStrip
                    row={row}
                    mx={mx}
                    cohort={cohort}
                    active={active}
                    setActive={setActive}
                  />
                  <MemberList members={row.members} />
                </td>
              </tr>
            ))}
            {/* One shared axis for the member strips, drawn once under the last row
                rather than repeated per row. */}
            <tr className="border-t border-[var(--color-line)]">
              <td colSpan={2} className="border-r border-[var(--color-line)]" />
              <td className="pl-4">
                <svg
                  width={STRIP_W}
                  height={18}
                  viewBox={`0 0 ${STRIP_W} 18`}
                  className="w-full"
                  aria-hidden="true"
                >
                  {ticksIn(cohort).map((t) => (
                    <text
                      key={t}
                      x={mx(t)}
                      y={11}
                      // The track is inset by a dot's radius at both ends, so the
                      // outermost labels are anchored inward rather than centred
                      // and clipped by the viewBox.
                      textAnchor={mx(t) < 12 ? 'start' : mx(t) > STRIP_W - 12 ? 'end' : 'middle'}
                      className="tnum fill-[var(--color-muted)] text-[10px]"
                    >
                      {t}
                    </text>
                  ))}
                </svg>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {hovered ? (
        <p className="mt-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5 text-[11px]">
          <span className="text-xs font-semibold">{hovered.name}</span>{' '}
          <span className="text-[var(--color-muted)]">· {hovered.level}</span>
          <span className="tnum ml-2 font-semibold">
            {hovered.score === null ? 'not scored' : `${hovered.score.toFixed(1)} vs cohort`}
          </span>
          {hovered.note ? (
            <span className="mt-1 block text-[10px] text-[var(--color-muted)]">{hovered.note}</span>
          ) : null}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-[var(--color-muted)]">
        <span className="flex items-center gap-1.5">
          <svg width="14" height="14" aria-hidden="true">
            <path
              d={diamond(7, 7, 4.5)}
              fill="var(--chart-series)"
              stroke="var(--chart-series)"
              strokeWidth="1"
            />
          </svg>
          Squad, against targets
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4" fill="var(--chart-series)" />
          </svg>
          One member, against their own cohort
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="14" height="14" aria-hidden="true">
            <circle
              cx="7"
              cy="7"
              r="3.5"
              fill="none"
              stroke="var(--chart-series)"
              strokeWidth="2"
            />
          </svg>
          Hollow: thin data or no cohort
        </span>
      </div>

      <MetricNote>
        The two columns are <strong>two different scales</strong> and are deliberately not one
        axis. A squad is scored 0-100 between a bad threshold and a good one, so 50 means halfway
        to the target and every squad can be near 100. An engineer is scored 0-100 against the
        median of their own seniority cohort, so 50 means half their level is either side of them
        and somebody is always below it. A squad at 99 beside members at 50 is not a squad
        outperforming its own people — it is a team comfortably clearing delivery targets whose
        members are, as they must be, spread around their cohort medians. Compare down each column,
        never across the rule.
        <br />
        <br />
        What the member column is for is the question the squad ranking cannot answer:{' '}
        <strong>uniformly strong, or carried</strong>. The bar behind the dots is the range from
        the squad&apos;s lowest-scoring member to its highest, so a knot is a squad where one score
        describes everybody and a long bar is a squad where it describes nobody. Read it with the
        squad&apos;s sub-scores rather than instead of them: a squad can be uniform and still be
        weak on one dimension, and it can lead the ranking on absolute targets while its members
        sit two interquartile ranges apart.
      </MetricNote>
    </div>
  )
}

/** The squad's own score, on its own fixed 0-100 target scale. */
function TargetTrack({
  score,
  solid,
  name,
}: {
  score: number | null
  solid: boolean
  name: string
}) {
  const value = measured(score)
  if (value === null) {
    return (
      <span className="text-[10px] text-[var(--color-muted)]" aria-label={`${name}: not scored`}>
        not scored
      </span>
    )
  }
  // Fixed full run, never cropped to the data — the thresholds are the whole point.
  // Inset by the marker's own radius at both ends so a squad on 100 is drawn whole
  // rather than as a half-diamond clipped by the viewBox, which is most of them.
  const at = (v: number) => DIAMOND_R + fractionIn(v, absoluteDomain()) * (TARGET_W - DIAMOND_R * 2)
  const x = at(value)
  return (
    <span className="flex items-center gap-2">
      <svg
        width={TARGET_W}
        height={TARGET_H}
        viewBox={`0 0 ${TARGET_W} ${TARGET_H}`}
        className="shrink-0"
        role="img"
        aria-label={`${name}: ${value.toFixed(1)} of 100 against absolute targets`}
      >
        <line
          x1={at(0)}
          x2={at(100)}
          y1={TARGET_H / 2}
          y2={TARGET_H / 2}
          stroke="var(--chart-grid)"
          strokeWidth={2}
          strokeLinecap="round"
        />
        {/* Halfway between the bad and the good threshold — a real midpoint here. */}
        <line
          x1={at(TARGET_MIDPOINT)}
          x2={at(TARGET_MIDPOINT)}
          y1={TARGET_H / 2 - 4}
          y2={TARGET_H / 2 + 4}
          stroke="var(--chart-ref)"
          strokeWidth={1}
        />
        <path
          d={diamond(x, TARGET_H / 2, DIAMOND_R + 2)}
          fill="var(--color-surface)"
          stroke="var(--color-surface)"
          strokeWidth={2}
        />
        <path
          d={diamond(x, TARGET_H / 2, DIAMOND_R)}
          fill={solid ? 'var(--chart-series)' : 'none'}
          stroke="var(--chart-series)"
          strokeWidth={solid ? 1 : 2}
        />
      </svg>
      <span className="tnum w-9 shrink-0 text-[11px] font-medium">{value.toFixed(1)}</span>
    </span>
  )
}

/** One squad's members, on the cohort scale shared by every row. */
function MemberStrip({
  row,
  mx,
  cohort,
  active,
  setActive,
}: {
  row: SquadCompositionRow
  mx: (v: number) => number
  cohort: [number, number]
  active: string | null
  setActive: Dispatch<SetStateAction<string | null>>
}) {
  const scored = row.members.flatMap((m) => {
    const value = measured(m.score)
    return value === null ? [] : [{ member: m, value }]
  })
  if (scored.length === 0) {
    // The list underneath says who is here and that nobody is scored, so a second
    // sentence in the same cell would only repeat it.
    return null
  }

  const sorted = [...scored]
    .sort((a, b) => a.value - b.value)
    .map((entry) => ({ ...entry, x: mx(entry.value) }))
  // Dots closer together than their own diameter stop being two dots. Sliding the
  // later one into a lane above or below keeps both countable without moving either
  // along the axis, which is the only direction that carries a value.
  const lastInLane = LANES.map(() => Number.NEGATIVE_INFINITY)
  const placed = sorted.map((entry) => {
    const lane = LANES.findIndex((_, i) => entry.x - lastInLane[i]! >= DOT_R * 2 + 2)
    const index = lane === -1 ? 0 : lane
    lastInLane[index] = entry.x
    return { ...entry, dy: LANES[index]! }
  })

  const low = placed[0]!
  const high = placed[placed.length - 1]!
  // Naming both ends is what answers "carried", but two names on top of each other
  // point at both dots and answer nothing — so a tight row is left to the list
  // underneath and to focus.
  const nameable = placed.length > 1 && high.x - low.x >= 60
  const height = nameable ? STRIP_H.named : STRIP_H.bare

  return (
    <svg
      width={STRIP_W}
      height={height}
      viewBox={`0 0 ${STRIP_W} ${height}`}
      className="w-full"
      role="img"
      aria-label={`${row.name}: ${placed.length} scored ${
        placed.length === 1 ? 'member' : 'members'
      } from ${low.value.toFixed(1)} to ${high.value.toFixed(1)} against their own cohorts`}
    >
      {ticksIn(cohort).map((t) => (
        <line
          key={t}
          x1={mx(t)}
          x2={mx(t)}
          y1={0}
          y2={STRIP_CY + 10}
          stroke="var(--chart-grid)"
          strokeWidth={1}
        />
      ))}
      <line
        x1={mx(MEDIAN)}
        x2={mx(MEDIAN)}
        y1={0}
        y2={STRIP_CY + 10}
        stroke="var(--chart-ref)"
        strokeWidth={1}
      />

      {/* The range from lowest to highest member: the spread is the finding. */}
      {placed.length > 1 ? (
        <line
          x1={low.x}
          x2={high.x}
          y1={STRIP_CY}
          y2={STRIP_CY}
          stroke="var(--chart-series)"
          strokeWidth={3}
          strokeLinecap="round"
          opacity={0.22}
        />
      ) : null}

      {placed.map(({ member, value, x, dy }) => {
        const dim = active !== null && member.id !== active
        const cy = STRIP_CY + dy
        return (
          <g key={member.id}>
            {/* A dot pushed into a lane is still at its own score, so it keeps a
                hairline back to the axis line it belongs on. */}
            {dy === 0 ? null : (
              <line
                x1={x}
                x2={x}
                y1={STRIP_CY}
                y2={cy}
                stroke="var(--chart-series)"
                strokeWidth={1}
                opacity={0.35}
              />
            )}
            <circle cx={x} cy={cy} r={DOT_R + 2} fill="var(--color-surface)" />
            {member.id === active ? (
              <circle
                cx={x}
                cy={cy}
                r={DOT_R + 5}
                fill="none"
                stroke="var(--chart-series)"
                strokeWidth={1.5}
                opacity={0.55}
              />
            ) : null}
            <ConfidenceDot
              cx={x}
              cy={cy}
              r={DOT_R + 1}
              mark={confidenceMark(member.confidence)}
              hollowFill="none"
              opacity={dim ? 0.35 : 1}
            />
            <circle
              cx={x}
              cy={cy}
              r={12}
              fill="transparent"
              tabIndex={0}
              role="button"
              aria-label={`${member.name}, ${member.level}, ${row.name}, ${value.toFixed(
                1,
              )} of 100 against their own seniority cohort where 50 is the median`}
              className="cursor-pointer outline-none focus-visible:stroke-[var(--color-ink)]"
              onMouseEnter={() => setActive(member.id)}
              onMouseLeave={() => setActive((c) => (c === member.id ? null : c))}
              onFocus={() => setActive(member.id)}
              onBlur={() => setActive((c) => (c === member.id ? null : c))}
            />
          </g>
        )
      })}

      {nameable ? (
        <>
          <text
            x={Math.max(low.x - 8, 0)}
            y={STRIP_CY + 26}
            textAnchor={low.x < 60 ? 'start' : 'end'}
            className="fill-[var(--color-muted)] text-[9px]"
          >
            {shortName(low.member.name)}
          </text>
          <text
            x={Math.min(high.x + 8, STRIP_W)}
            y={STRIP_CY + 26}
            textAnchor={high.x > STRIP_W - 60 ? 'end' : 'start'}
            className="fill-[var(--color-muted)] text-[9px]"
          >
            {shortName(high.member.name)}
          </text>
        </>
      ) : null}
    </svg>
  )
}

/**
 * Every member and score as text, because a dot is not a value and half of these
 * rows are too tight to label. Also the only place an unscored member appears,
 * since there is no position to draw one at.
 */
function MemberList({ members }: { members: SquadCompositionMember[] }) {
  if (members.length === 0) {
    return <p className="mt-1 text-[10px] text-[var(--color-muted)]">Nobody in this squad.</p>
  }
  const ordered = [...members].sort((a, b) => (measured(b.score) ?? -1) - (measured(a.score) ?? -1))
  return (
    <p className="tnum mt-1 text-[10px] leading-relaxed text-[var(--color-muted)]">
      {ordered.map((m, i) => (
        <span key={m.id}>
          {i > 0 ? ' · ' : ''}
          <span className={isSolidMark(m.confidence) ? undefined : 'italic'}>{m.name}</span>{' '}
          {measured(m.score) === null ? 'not scored' : measured(m.score)!.toFixed(1)}
        </span>
      ))}
    </p>
  )
}

/** How far apart the squad's members are, which is the question in one number. */
function SpreadNote({ members }: { members: SquadCompositionMember[] }) {
  const scores = members.flatMap((m) => {
    const value = measured(m.score)
    return value === null ? [] : [value]
  })
  const unscored = members.length - scores.length
  const suffix = unscored > 0 ? ` · ${unscored} not scored` : ''

  if (scores.length === 0) {
    return (
      <span className="block text-[10px] text-[var(--color-muted)]">
        no scored members{suffix}
      </span>
    )
  }
  if (scores.length === 1) {
    return (
      <span className="block text-[10px] text-[var(--color-muted)]">
        one scored member — nothing to spread{suffix}
      </span>
    )
  }
  const spread = Math.max(...scores) - Math.min(...scores)
  return (
    <span className="tnum block text-[10px] text-[var(--color-muted)]">
      {spread.toFixed(1)} pt spread{suffix}
    </span>
  )
}

function diamond(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`
}

/** "Aleksandra Tokarz" → "Aleksandra T." — short enough to sit beside a dot. */
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/)
  if (parts.length < 2) return parts[0] ?? full
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`
}
