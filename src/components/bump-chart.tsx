'use client'

import { useState } from 'react'

import {
  captureLabel,
  describeTrend,
  scoreTrend,
  sortPoints,
  type ScorePoint,
} from '@/lib/score-history'
import { captureX, polylinePoints, rankY, tieOffsetGrid } from '@/lib/trend-geometry'

/**
 * Where each subject sat in the ranking at each capture, one line per subject.
 *
 * The closest precedent in this app is `rank-slope.tsx`, and the decisions carry
 * over: **the rank axis is inverted**, 1 at the top, because a rank is a position and
 * everybody reads first as up; the line is the hit target rather than its ends,
 * because two subjects can share a rank exactly; and the readout sits under the plot
 * instead of floating over it, because every line crosses the middle of a chart whose
 * neighbours are the only thing a rank means anything against.
 *
 * What this chart has to handle that the slope chart does not is a **tie that never
 * resolves**. Alan Patekar and Mehmet Cetin both hold rank 6 on a score of 50.8 in
 * the only capture this database has. Two subjects on one rank at one capture are
 * drawn as one line, and the second of them then has no mark, no target and no
 * mention — the chart quietly loses a person. So tied subjects are fanned apart by a
 * fixed offset (`rankTieOffsets`, tested), centred on the rank they share so neither
 * is demoted to make room, and small enough that the pair still reads as one rank.
 * A tied subject's hit strip is narrower than an untied one's for the same reason it
 * has to exist at all: two overlapping strips would hand every pointer event to
 * whichever line was drawn last. Keyboard focus reaches both regardless — one tab
 * stop per subject, in rank order — and every rank is also in the ranked table on
 * this page, which is what makes the chart an addition rather than the only way to
 * read the data.
 *
 * **No line is ever drawn across a `definition_version` boundary.** A rank under one
 * formula and a rank under the next are two orderings of two different quantities;
 * joining them would draw a climb or a fall that nobody measured. The break is
 * marked, and the two stretches are separate polylines.
 */

export type BumpSubject = {
  id: string
  name: string
  /** Short enough to sit at the end of a line: "Marcin N.", "Monetization". */
  shortName: string
  /** Every capture of this subject. Sorted here, so callers need not. */
  points: ScorePoint[]
}

export type BumpChartProps = {
  subjects: BumpSubject[]
  /** Singular noun for one line — "engineer", "squad". Used in prose and labels. */
  subjectNoun: string
  /** Plural of the above. */
  subjectPlural: string
}

const W = 720
const PAD = { top: 46, bottom: 40, left: 46, right: 148 }
const ROW = 30
/** Vertical gap between two subjects sharing a rank. Kept below half a row. */
const TIE_SPREAD = 11
/** Hit strip for a line nobody shares a rank with. */
const STRIP = 22

export function BumpChart({ subjects, subjectNoun, subjectPlural }: BumpChartProps) {
  const [active, setActive] = useState<string | null>(null)

  const prepared = subjects.map((s) => {
    const points = sortPoints(s.points)
    return {
      ...s,
      points,
      byDay: new Map(points.map((p) => [p.capturedFor, p])),
    }
  })

  const days = [...new Set(prepared.flatMap((s) => s.points.map((p) => p.capturedFor)))].sort()
  const ranked = prepared.filter((s) => s.points.some((p) => p.rankInOrg !== null))

  // --- the state that is correct today ---------------------------------------
  //
  // One capture is not a broken chart, it is the beginning of the series: there is
  // deliberately no backfill, because running today's formula over June's window
  // would manufacture exactly the continuity `definition_version` exists to prevent.
  // Drawing anything here — a flat line, a single point stretched across the box —
  // would claim a measurement that was never taken. The ranks that *do* exist are
  // listed instead, so the block carries information rather than an apology.
  if (days.length < 2 || ranked.length === 0) {
    const day = days[days.length - 1]
    const standing = ranked
      .map((s) => ({ ...s, latest: s.points[s.points.length - 1]! }))
      .filter((s) => s.latest.rankInOrg !== null)
      .sort((a, b) => a.latest.rankInOrg! - b.latest.rankInOrg! || a.name.localeCompare(b.name))

    return (
      <div>
        <p className="text-sm font-medium">Not enough history yet</p>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--color-muted)]">
          {days.length === 0
            ? `No score has been captured for this period, so there is no ranking to track. History starts the first time the capture runs.`
            : `One capture, ${captureLabel(day!)}. A rank cannot move until there are two, and there is no backfill to create one — the formula that produced last month's scores no longer exists in the database, so running today's over last month's window would invent a trend rather than recover it.`}
        </p>
        {standing.length > 0 ? (
          <>
            <p className="mt-3 text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
              Recorded on {captureLabel(day!)}
            </p>
            {standing.some((s, i) => i > 0 && s.latest.rankInOrg === standing[i - 1]!.latest.rankInOrg) ? (
              <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                A repeated number is a tie, and the dense ordering then skips the number below it —
                two subjects on 6 means there is no 7.
              </p>
            ) : null}
            <ol className="mt-1.5 grid gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {standing.map((s) => (
                <li key={s.id} className="flex items-baseline gap-2">
                  <span className="tnum w-6 text-right text-[var(--color-muted)]">
                    {s.latest.rankInOrg}
                  </span>
                  <span className="truncate">{s.name}</span>
                  <span className="tnum ml-auto text-[var(--color-muted)]">
                    {s.latest.score === null ? 'no score' : s.latest.score.toFixed(1)}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>
    )
  }

  // --- geometry ---------------------------------------------------------------

  const maxRank = Math.max(
    ...prepared.flatMap((s) => s.points.map((p) => p.rankInOrg ?? 1)),
    2,
  )
  const trackTop = PAD.top
  const trackBottom = PAD.top + (maxRank - 1) * ROW
  const H = trackBottom + PAD.bottom
  const left = PAD.left
  const right = W - PAD.right

  const x = (day: string) => captureX(days.indexOf(day), days.length, left, right)
  const offsets = tieOffsetGrid(
    days,
    prepared.map((s) => ({ id: s.id, rankOn: (day: string) => s.byDay.get(day)?.rankInOrg ?? null })),
    TIE_SPREAD,
  )
  const y = (day: string, rank: number, id: string) =>
    rankY(rank, maxRank, trackTop, trackBottom) + (offsets.get(`${day}|${id}`) ?? 0)

  /** True when this subject shares a rank with someone at any capture. */
  const tied = new Set(
    prepared
      .filter((s) => days.some((d) => (offsets.get(`${d}|${s.id}`) ?? 0) !== 0))
      .map((s) => s.id),
  )

  // A boundary between two captures where any subject's formula changed. Drawn once
  // for the whole chart: the version is stamped org-wide, so it is a fact about the
  // capture rather than about a line.
  const breaks: { at: number; from: string; to: string }[] = []
  for (let i = 1; i < days.length; i += 1) {
    const before = new Set(prepared.map((s) => s.byDay.get(days[i - 1]!)?.definitionVersion).filter(Boolean))
    const after = new Set(prepared.map((s) => s.byDay.get(days[i]!)?.definitionVersion).filter(Boolean))
    const changed = [...after].some((v) => !before.has(v!))
    if (changed && before.size > 0) {
      breaks.push({
        at: (x(days[i - 1]!) + x(days[i]!)) / 2,
        from: [...before].join(', ') as string,
        to: [...after].join(', ') as string,
      })
    }
  }

  const hovered = prepared.find((s) => s.id === active) ?? null
  const hoveredTrend = hovered ? scoreTrend(hovered.points) : null
  const hoveredLatest = hovered ? hovered.points[hovered.points.length - 1] : null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Rank across ${days.length} captures for ${ranked.length} ${subjectPlural}`}
      >
        {/* --- rank rows, recessive ------------------------------------------ */}
        {Array.from({ length: maxRank }, (_, i) => i + 1).map((rank) => (
          <g key={rank}>
            <line
              x1={left}
              x2={right}
              y1={rankY(rank, maxRank, trackTop, trackBottom)}
              y2={rankY(rank, maxRank, trackTop, trackBottom)}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={left - 12}
              y={rankY(rank, maxRank, trackTop, trackBottom) + 3.5}
              textAnchor="end"
              className="tnum fill-[var(--color-muted)] text-[10px]"
            >
              {rank}
            </text>
          </g>
        ))}
        <text
          x={left - 12}
          y={trackTop - 26}
          textAnchor="end"
          className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
        >
          rank
        </text>
        <text x={left} y={trackTop - 26} className="fill-[var(--color-ink)] text-[11px] font-medium">
          1 at the top, because first place reads as up
        </text>

        {/* --- captures ------------------------------------------------------- */}
        {days.map((day) => (
          <g key={day}>
            <line
              x1={x(day)}
              x2={x(day)}
              y1={trackTop - 10}
              y2={trackBottom + 10}
              stroke="var(--chart-axis)"
              strokeWidth={1}
            />
            <text
              x={x(day)}
              y={trackBottom + 26}
              textAnchor="middle"
              className="fill-[var(--color-muted)] text-[10px]"
            >
              {captureLabel(day)}
            </text>
          </g>
        ))}

        {/* --- where the formula changed -------------------------------------- */}
        {breaks.map((b) => (
          <g key={b.at}>
            <line
              x1={b.at}
              x2={b.at}
              y1={trackTop - 16}
              y2={trackBottom + 12}
              stroke="var(--chart-ref)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <text
              x={b.at}
              y={trackTop - 20}
              textAnchor="middle"
              className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
            >
              definition changed
            </text>
          </g>
        ))}

        {/* --- one line per subject ------------------------------------------- */}
        {prepared.map((subject) => {
          const dim = active !== null && subject.id !== active
          const drawn = subject.points.filter((p) => p.rankInOrg !== null)
          if (drawn.length === 0) return null

          // Split into stretches that share a formula, and never join them.
          const segments: ScorePoint[][] = []
          for (const point of drawn) {
            const open = segments[segments.length - 1]
            if (open && open[open.length - 1]!.definitionVersion === point.definitionVersion) {
              open.push(point)
            } else segments.push([point])
          }

          const at = (p: ScorePoint) => ({
            x: x(p.capturedFor),
            y: y(p.capturedFor, p.rankInOrg!, subject.id),
          })
          const end = drawn[drawn.length - 1]!

          return (
            <g key={subject.id}>
              {segments
                .filter((seg) => seg.length > 1)
                .map((seg) => (
                  <polyline
                    key={seg[0]!.capturedFor}
                    points={polylinePoints(seg.map(at))}
                    fill="none"
                    stroke="var(--chart-series)"
                    strokeWidth={subject.id === active ? 2.5 : 1.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={dim ? 0.18 : subject.id === active ? 1 : 0.65}
                  />
                ))}
              {drawn.map((p) => {
                const c = at(p)
                const solid = p.confidence === 'high'
                return (
                  <g key={p.capturedFor}>
                    {/* 2px surface ring, so a tie that is still tight stays countable. */}
                    <circle cx={c.x} cy={c.y} r={5.5} fill="var(--color-surface)" opacity={dim ? 0.4 : 1} />
                    {subject.id === active ? (
                      <circle
                        cx={c.x}
                        cy={c.y}
                        r={8.5}
                        fill="none"
                        stroke="var(--chart-series)"
                        strokeWidth={1.5}
                        opacity={0.55}
                      />
                    ) : null}
                    <circle
                      cx={c.x}
                      cy={c.y}
                      r={3.5}
                      fill={solid ? 'var(--chart-series)' : 'var(--color-surface)'}
                      stroke="var(--chart-series)"
                      strokeWidth={solid ? 0 : 2}
                      opacity={dim ? 0.35 : 1}
                    />
                  </g>
                )
              })}
              <text
                x={right + 12}
                y={at(end).y + 3.5}
                className="fill-[var(--color-muted)] text-[10px]"
                opacity={dim ? 0.35 : 1}
              >
                {subject.shortName}
              </text>

              {/* One tab stop per subject, and the whole line is the target. A subject
                  that shares a rank with somebody gets a narrower strip so the two
                  strips do not overlap — an overlap would hand every pointer event to
                  whichever line happens to be drawn last, which is how a tie loses a
                  person. */}
              <polyline
                points={polylinePoints(drawn.map(at))}
                fill="none"
                stroke="transparent"
                strokeWidth={tied.has(subject.id) ? TIE_SPREAD : STRIP}
                strokeLinecap="round"
                tabIndex={0}
                role="button"
                aria-label={`${subject.name}, ${subjectNoun}. ${describeRanks(drawn)}`}
                // The focus ring narrows the strip as it colours it, so the indicator
                // traces the line instead of covering it: a 22px ink band would hide
                // the marks of the very line the reader just selected. CSS
                // `stroke-width` wins over the presentation attribute, which is what
                // makes the variant work.
                className="cursor-pointer outline-none focus-visible:[stroke-width:2.5px] focus-visible:stroke-[var(--color-ink)]"
                onMouseEnter={() => setActive(subject.id)}
                onMouseLeave={() => setActive((c) => (c === subject.id ? null : c))}
                onFocus={() => setActive(subject.id)}
                onBlur={() => setActive((c) => (c === subject.id ? null : c))}
              />
            </g>
          )
        })}
      </svg>

      <div className="mt-2 min-h-[3.25rem] border-t border-[var(--color-line)] pt-2">
        {hovered && hoveredTrend && hoveredLatest ? (
          <p className="text-[11px] leading-relaxed">
            <span className="font-semibold">{hovered.name}</span>
            <span className="text-[var(--color-muted)]">
              {' · '}
              <span className="tnum">{describeRanks(hovered.points.filter((p) => p.rankInOrg !== null))}</span>
              {hoveredLatest.score !== null ? (
                <>
                  {' · '}
                  <span className="tnum">{hoveredLatest.score.toFixed(1)} now</span>
                </>
              ) : null}
              {' — '}
              {describeTrend(hoveredTrend)}
              {hoveredLatest.confidenceReason ? ` ${hoveredLatest.confidenceReason}.` : ''}
            </span>
          </p>
        ) : (
          <p className="text-[11px] text-[var(--color-muted)]">
            Hover or focus a line to read every rank it holds. Both give the same readout, and
            every rank is also in the ranked table on this page.
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-muted)]">
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
          Thin data or no cohort at that capture
        </span>
        {tied.size > 0 ? (
          <span>
            {tied.size} {tied.size === 1 ? `${subjectNoun} shares` : `${subjectPlural} share`} a rank
            with somebody at some capture, so those lines are nudged apart to stay countable. The
            rank they share is the one on the axis between them.
          </span>
        ) : null}
        {breaks.length > 0 ? (
          <span>
            The dashed rule is a scoring-definition change. Lines stop at it rather than crossing
            it: the ranks either side order two different quantities.
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** "#6 on 31 Jul, #4 on 30 Aug" — every rank the line holds, in order. */
function describeRanks(points: readonly ScorePoint[]): string {
  return points.map((p) => `#${p.rankInOrg} on ${captureLabel(p.capturedFor)}`).join(', ')
}
