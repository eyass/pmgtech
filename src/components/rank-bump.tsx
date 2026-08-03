'use client'

import { useState } from 'react'

import { captureDates, toRankSeries, type EngineerScoreSnapshot } from '@/lib/score-history'

/**
 * Org rank over successive captures — the question `0025_score_snapshots.sql` opens
 * by saying the dashboard cannot answer: "who is first today" was easy, "were they
 * first last month" was impossible, because every score was recomputed from a date
 * range at request time and nothing was written down.
 *
 * Now that captures accumulate, this is that answer. One line per engineer, rank 1
 * at the top because everyone reads first place as up.
 *
 * Three decisions worth recording:
 *
 * 1. **Version changes break the line, they do not dash it.** Where two adjacent
 *    captures were computed under different `definition_version`s, no segment is
 *    drawn between them. A rank that moved because the formula changed is not
 *    movement, and 0029 is a live example: it shifted eight seniors by half a point
 *    each without anyone's work changing. A continuous line across that boundary
 *    would be a lie the chart tells confidently.
 * 2. **Ties share a rank, so lines can overlap exactly.** `rank_in_org` is dense.
 *    Rather than jitter them apart — which invents a distinction the data does not
 *    make — overlapping lines are left overlapping and hover disambiguates.
 * 3. **The axis is capture order, not calendar time.** Captures are nightly but not
 *    guaranteed; a missed night should not stretch the gap and imply drift that was
 *    never measured. Dates are on the axis labels and in every hover readout.
 *
 * With fewer than two capture dates there is nothing to plot, and the component says
 * which of the two reasons applies rather than rendering an empty frame.
 */
export function RankBump({
  rows,
  maxSeries = 14,
}: {
  rows: EngineerScoreSnapshot[]
  /** Cap on drawn lines, best current rank first. Anything dropped is stated below. */
  maxSeries?: number
}) {
  const [hovered, setHovered] = useState<string | null>(null)

  const dates = captureDates(rows)
  const allSeries = toRankSeries(rows)

  if (dates.length < 2) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        {dates.length === 0
          ? 'No score snapshots captured yet, so there is no ranking history to draw.'
          : 'Only one capture so far. A second one — the nightly job runs at 03:30 — gives this its first line.'}
      </p>
    )
  }

  const series = allSeries.slice(0, maxSeries)
  const dropped = allSeries.length - series.length

  const ranks = series.flatMap((s) => s.points.map((p) => p.rank))
  const worstRank = Math.max(...ranks)

  const width = 720
  const height = 300
  const padLeft = 34
  const padRight = 96
  const padTop = 16
  const padBottom = 34

  const innerW = width - padLeft - padRight
  const innerH = height - padTop - padBottom

  const xFor = (dateIndex: number) =>
    padLeft + (dates.length === 1 ? innerW / 2 : (dateIndex / (dates.length - 1)) * innerW)

  // Rank 1 at the top. Domain runs 1..worstRank so the bottom line is not clipped.
  const yFor = (rank: number) => padTop + ((rank - 1) / Math.max(worstRank - 1, 1)) * innerH

  const colours = [
    'var(--color-squad-buyer)',
    'var(--color-squad-seller)',
    'var(--color-squad-monetization)',
    'var(--color-squad-growth)',
  ]

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Org rank across ${dates.length} captures for ${series.length} engineers, rank 1 at the top`}
      >
        <title>{`Org rank across ${dates.length} captures for ${series.length} engineers`}</title>

        {/* rank gridlines */}
        {Array.from({ length: worstRank }, (_, i) => i + 1)
          .filter((r) => r === 1 || r === worstRank || r % 5 === 0)
          .map((rank) => (
            <g key={rank}>
              <line
                x1={padLeft}
                x2={padLeft + innerW}
                y1={yFor(rank)}
                y2={yFor(rank)}
                stroke="var(--color-line)"
                strokeWidth={1}
              />
              <text
                x={padLeft - 8}
                y={yFor(rank) + 3}
                textAnchor="end"
                className="fill-[var(--color-muted)] text-[9px]"
              >
                {rank}
              </text>
            </g>
          ))}

        {/* capture dates */}
        {dates.map((date, i) => (
          <text
            key={date}
            x={xFor(i)}
            y={height - padBottom + 16}
            textAnchor="middle"
            className="fill-[var(--color-muted)] text-[9px]"
          >
            {date.slice(5)}
          </text>
        ))}

        {series.map((s, seriesIndex) => {
          const colour = colours[seriesIndex % colours.length]
          const dimmed = hovered !== null && hovered !== s.engineerId

          // Break the line wherever the formula changed between adjacent captures.
          const runs: { x: number; y: number }[][] = []
          let run: { x: number; y: number }[] = []
          let previousVersion: string | null = null

          for (const point of s.points) {
            const x = xFor(dates.indexOf(point.capturedFor))
            const y = yFor(point.rank)
            if (previousVersion !== null && point.definitionVersion !== previousVersion) {
              if (run.length > 0) runs.push(run)
              run = []
            }
            run.push({ x, y })
            previousVersion = point.definitionVersion
          }
          if (run.length > 0) runs.push(run)

          const last = s.points[s.points.length - 1]

          return (
            <g
              key={s.engineerId}
              opacity={dimmed ? 0.18 : 1}
              onMouseEnter={() => setHovered(s.engineerId)}
              onMouseLeave={() => setHovered(null)}
              className="cursor-default"
            >
              {runs.map((r, i) => (
                <path
                  key={i}
                  d={r.map((p, j) => `${j === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')}
                  fill="none"
                  stroke={colour}
                  strokeWidth={hovered === s.engineerId ? 2.5 : 1.5}
                  strokeLinecap="round"
                />
              ))}

              {s.points.map((point) => (
                <circle
                  key={point.capturedFor}
                  cx={xFor(dates.indexOf(point.capturedFor))}
                  cy={yFor(point.rank)}
                  r={hovered === s.engineerId ? 3.5 : 2.5}
                  fill={colour}
                >
                  <title>{`${s.fullName} — rank ${point.rank} on ${point.capturedFor}`}</title>
                </circle>
              ))}

              <text
                x={xFor(dates.indexOf(last.capturedFor)) + 8}
                y={yFor(last.rank) + 3}
                className="text-[10px]"
                fill={colour}
              >
                {s.fullName.split(' ')[0]}
              </text>
            </g>
          )
        })}
      </svg>

      {dropped > 0 ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Showing the {series.length} best current ranks. {dropped} further{' '}
          {dropped === 1 ? 'engineer is' : 'engineers are'} in the data and not drawn.
        </p>
      ) : null}
    </div>
  )
}
