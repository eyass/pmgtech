'use client'

import { useState } from 'react'

import { captureLabel, signed, type MoversResult, type RankMove } from '@/lib/score-history'
import { rankY } from '@/lib/trend-geometry'

/**
 * Who climbed and who fell, and — far more often in this org — why nobody did.
 *
 * A movers list is the most quotable thing a dashboard can produce, which is exactly
 * why it needs the strictest gate on the page. A rank here is a dense ordering over a
 * composite whose spread is 6.6 points across eleven of fourteen engineers, so ranks
 * reshuffle on rounding. This list therefore reports a rank move only when the score
 * behind it moved by at least one interquartile range — `MATERIAL_SCORE_GAP`, the
 * same 15 points the tie bands and the standing pills use, imported rather than
 * reinvented.
 *
 * The consequence is deliberate: **the list is usually empty, and the empty state is
 * the finding.** "Four ranks moved and none of them clear the noise floor" is a true
 * and useful sentence. Falling back to the largest available movement when nothing
 * qualifies would turn it into a false one, and it is the single easiest way for a
 * chart like this to start a conversation about somebody on the basis of nothing.
 *
 * The other refusal is the version boundary. A subject whose latest capture is the
 * first under a new formula has no delta in either direction — not zero, not
 * unchanged. Those are named separately, because "we changed how we measure" is a
 * different fact from "nothing happened" and they must never be shown as the same.
 *
 * The mini slope beside each row is two ranks on one shared inverted axis, so the
 * steepness of one row is comparable with the steepness of another.
 */

export type MoversProps = {
  /** From `rankMovers` in `lib/score-history.ts`, which owns the gate. */
  result: MoversResult
  /** Singular noun for one row — "engineer", "squad". */
  subjectNoun: string
  /** Plural of the above. */
  subjectPlural: string
}

const SLOPE_W = 46
const SLOPE_H = 30
const SLOPE_PAD = 6

export function Movers({ result, subjectNoun, subjectPlural }: MoversProps) {
  const { climbers, fallers, gated, heldRank, redefined, tooShort, unranked, captures, maxRank, gap } =
    result
  const nothing = climbers.length === 0 && fallers.length === 0

  if (captures < 2) {
    return (
      <div>
        <p className="text-sm font-medium">Nothing can have moved yet</p>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--color-muted)]">
          {captures === 0
            ? `No score has been captured for this period.`
            : `There is one capture. A climb or a fall is a difference between two, and there is no backfill that could supply the first — so this list starts filling up after the next capture, not before.`}
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Column
        title="Climbed"
        empty={`No ${subjectNoun} climbed on a score change large enough to be real.`}
        moves={climbers}
        maxRank={maxRank}
      />
      <Column
        title="Fell"
        empty={`No ${subjectNoun} fell on a score change large enough to be real.`}
        moves={fallers}
        maxRank={maxRank}
      />

      <div className="md:col-span-2">
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">
          {nothing ? (
            <>
              <strong className="text-[var(--color-ink)]">
                Nothing cleared the {gap}-point gate this period.
              </strong>{' '}
            </>
          ) : null}
          A rank only appears above when the score behind it moved by at least {gap} points — one
          interquartile range of a cohort, the same threshold the tie bands and the standing pills
          use. Ranks in a group this tight move on rounding, and reporting those as climbs and
          falls would put a name next to a number that did not change.
        </p>

        {gated.length > 0 ? (
          <div className="mt-2">
            <p className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
              Moved rank, inside the noise
            </p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-muted)]">
              {gated.map((g) => (
                <li key={g.id} className="tnum">
                  {g.name}: #{g.rankFrom} → #{g.rankTo} on {signed(g.scoreChange)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {heldRank.length > 0 ? (
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
            <strong className="text-[var(--color-ink)]">Moved materially without moving rank:</strong>{' '}
            {heldRank.map((h) => `${h.name} ${signed(h.scoreChange)} while holding #${h.rank}`).join('; ')}.
            A climb at either end of an ordering has nowhere to go, so this is the one real change a
            rank-based list would otherwise lose entirely.
          </p>
        ) : null}

        {redefined.length > 0 ? (
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
            <strong className="text-[var(--color-ink)]">
              {redefined.length} {redefined.length === 1 ? subjectNoun : subjectPlural} cannot be
              compared at all:
            </strong>{' '}
            their latest capture is the first under a new scoring definition, so there is no
            movement to state in either direction — {redefined.join(', ')}.
          </p>
        ) : null}

        {tooShort > 0 || unranked > 0 ? (
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
            {tooShort > 0
              ? `${tooShort} ${tooShort === 1 ? subjectNoun : subjectPlural} ${tooShort === 1 ? 'has' : 'have'} fewer than two comparable captures. `
              : ''}
            {unranked > 0
              ? `${unranked} ${unranked === 1 ? 'was' : 'were'} captured without a rank, so no rank move exists for ${unranked === 1 ? 'it' : 'them'}.`
              : ''}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function Column({
  title,
  empty,
  moves,
  maxRank,
}: {
  title: string
  empty: string
  moves: RankMove[]
  maxRank: number
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{title}</p>
      {moves.length === 0 ? (
        <p className="mt-1.5 text-xs text-[var(--color-muted)]">{empty}</p>
      ) : (
        <ul className="mt-1.5 max-w-sm space-y-1.5">
          {moves.map((move) => (
            <MoverRow key={move.id} move={move} maxRank={maxRank} />
          ))}
        </ul>
      )}
    </div>
  )
}

function MoverRow({ move, maxRank }: { move: RankMove; maxRank: number }) {
  const [active, setActive] = useState(false)

  const y1 = rankY(move.rankFrom, maxRank, SLOPE_PAD, SLOPE_H - SLOPE_PAD)
  const y2 = rankY(move.rankTo, maxRank, SLOPE_PAD, SLOPE_H - SLOPE_PAD)
  const readout = `${move.name}: rank ${move.rankFrom} on ${captureLabel(move.fromDay)} to rank ${move.rankTo} on ${captureLabel(move.toDay)}, score ${move.scoreFrom.toFixed(1)} to ${move.scoreTo.toFixed(1)}, a change of ${signed(move.scoreChange)} points.`

  return (
    <li
      className="flex items-center gap-3 rounded-lg px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ink)]"
      tabIndex={0}
      aria-label={readout}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
    >
      {/* Two ranks on the shared inverted axis: the same slope means the same movement
          in every row of both columns. */}
      <svg width={SLOPE_W} height={SLOPE_H} viewBox={`0 0 ${SLOPE_W} ${SLOPE_H}`} aria-hidden="true">
        <line
          x1={SLOPE_PAD}
          x2={SLOPE_W - SLOPE_PAD}
          y1={y1}
          y2={y2}
          stroke="var(--chart-series)"
          strokeWidth={active ? 2.25 : 1.5}
        />
        {[
          { cx: SLOPE_PAD, cy: y1, solid: true },
          { cx: SLOPE_W - SLOPE_PAD, cy: y2, solid: move.solid },
        ].map((end) => (
          <g key={end.cx}>
            <circle cx={end.cx} cy={end.cy} r={4} fill="var(--color-surface)" />
            <circle
              cx={end.cx}
              cy={end.cy}
              r={2.5}
              fill={end.solid ? 'var(--chart-series)' : 'var(--color-surface)'}
              stroke="var(--chart-series)"
              strokeWidth={end.solid ? 0 : 1.75}
            />
          </g>
        ))}
      </svg>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{move.name}</span>
        <span className="tnum block text-[11px] text-[var(--color-muted)]">
          #{move.rankFrom} → #{move.rankTo} · {signed(move.scoreChange)} pts ·{' '}
          {captureLabel(move.fromDay)} to {captureLabel(move.toDay)}
        </span>
      </span>
      <span className="tnum text-xs font-semibold">
        {move.rankChange > 0 ? '+' : '−'}
        {Math.abs(move.rankChange)}
      </span>
    </li>
  )
}
