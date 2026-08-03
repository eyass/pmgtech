import Link from 'next/link'

import { EmptyState, Pill, Table, Td, Th } from '@/components/ui'
import { computeMovers, type EngineerScoreSnapshot } from '@/lib/score-history'

/**
 * Who moved, between each engineer's two most recent comparable captures.
 *
 * The third of the three pieces `0025_score_snapshots.sql` records as lost with its
 * worktree, and the one that makes the snapshots worth capturing day to day: a
 * ranking tells you the state, movers tell you what changed since anyone last looked.
 *
 * Three things it refuses to do, each because the alternative would mislead:
 *
 * - **It will not compare across a formula change.** `computeMovers` drops any
 *   engineer whose latest capture and its predecessor carry different
 *   `definition_version`s. After a scoring migration this table can legitimately be
 *   empty for a night, and it says so rather than reporting the formula's effect as
 *   everyone having moved at once.
 * - **It will not treat a missing score as a zero.** An engineer with no score in
 *   one of the two captures has a null delta and is not ranked among the movers.
 * - **It will not hide the confidence.** A 9-point jump on a `thin` sample is
 *   mostly sampling noise, and a mover table that showed the jump without the
 *   caveat would be read as nine points of real change. The pill is on every row
 *   that carries one.
 *
 * Rank delta is stated the way a person would say it: rank 8 to rank 3 is "up 5".
 */
export function Movers({ rows, limit = 8 }: { rows: EngineerScoreSnapshot[]; limit?: number }) {
  const all = computeMovers(rows)
  const movers = all.filter((m) => m.scoreDelta !== null && m.scoreDelta !== 0)

  if (movers.length === 0) {
    return all.length > 0 ? (
      <EmptyState
        title="Nothing moved"
        body="Every engineer scored the same as the previous capture."
      />
    ) : (
      <EmptyState
        title="Nothing comparable yet"
        body="No two consecutive captures share a scoring formula, so there is nothing that can honestly be compared. This clears once a second capture lands under the current definition."
      />
    )
  }

  const shown = movers.slice(0, limit)

  return (
    <div>
      <Table
        empty="Nothing moved."
        head={
          <>
            <Th>Engineer</Th>
            <Th align="right">Score</Th>
            <Th align="right">Change</Th>
            <Th align="right">Rank</Th>
            <Th>Confidence</Th>
          </>
        }
      >
        {shown.map((m) => {
          const up = (m.scoreDelta ?? 0) > 0
          return (
            <tr key={m.engineerId}>
              <Td>
                <Link href={`/people/${m.engineerId}`} className="hover:underline">
                  {m.fullName}
                </Link>
                <div className="text-xs text-[var(--color-muted)]">{m.seniorityKey ?? '—'}</div>
              </Td>
              <Td align="right" numeric>
                {m.scoreTo === null ? '—' : m.scoreTo.toFixed(1)}
                <div className="text-xs text-[var(--color-muted)]">
                  from {m.scoreFrom === null ? '—' : m.scoreFrom.toFixed(1)}
                </div>
              </Td>
              <Td align="right" numeric>
                <span style={{ color: up ? 'var(--color-good)' : 'var(--color-bad)' }}>
                  {up ? '+' : ''}
                  {m.scoreDelta?.toFixed(1)}
                </span>
              </Td>
              <Td align="right" numeric>
                {m.rankTo === null ? (
                  '—'
                ) : (
                  <>
                    #{m.rankTo}
                    {m.rankDelta !== null && m.rankDelta !== 0 ? (
                      <div
                        className="text-xs"
                        style={{ color: m.rankDelta > 0 ? 'var(--color-good)' : 'var(--color-bad)' }}
                      >
                        {m.rankDelta > 0 ? '↑' : '↓'} {Math.abs(m.rankDelta)}
                      </div>
                    ) : (
                      <div className="text-xs text-[var(--color-muted)]">held</div>
                    )}
                  </>
                )}
              </Td>
              <Td>
                {m.confidence && m.confidence !== 'high' ? (
                  <Pill tone={m.confidence === 'no_cohort' ? 'bad' : 'warn'}>{m.confidence}</Pill>
                ) : (
                  <span className="text-xs text-[var(--color-muted)]">high</span>
                )}
              </Td>
            </tr>
          )
        })}
      </Table>

      <p className="mt-2 text-xs text-[var(--color-muted)]">
        Comparing {shown[0].previousCapturedFor} with {shown[0].capturedFor}
        {movers.length > shown.length
          ? ` · ${movers.length - shown.length} smaller ${movers.length - shown.length === 1 ? 'move' : 'moves'} not shown`
          : null}
      </p>
    </div>
  )
}
