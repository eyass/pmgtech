'use client'

import { useState } from 'react'

import { MetricNote } from '@/components/ui'
import {
  absoluteDomain,
  bubbleRadius,
  fractionIn,
  measuredPairs,
  TARGET_MIDPOINT,
  ticksIn,
} from '@/lib/chart-scale'

/**
 * Squads on two of their four dimensions, with headcount as bubble area.
 *
 * This is the engineer scatter's opposite number, and the difference is the whole
 * point of it: **squads are scored against absolute targets, not against each
 * other.** Three consequences follow, and each one is a choice against the more
 * flattering alternative.
 *
 * 1. **The domain is the fixed full 0-100 and never rescales to the data.** 0 is
 *    the bad threshold, 100 is the good one. The engineer charts take a 40-point
 *    minimum span and crop to the cohort, because there 50 is a median and only
 *    relative position means anything. Here cropping would destroy the only thing
 *    the axis says. With this org's data every scored squad sits at 98-100 on flow
 *    and collaboration; a fitted axis would spread that ceiling across the whole
 *    plot and turn "everybody clears the target" into "somebody is last".
 * 2. **The reference lines are the target midpoint, not a cohort median.** Nobody
 *    has to be near them. All five squads sitting top-right is a valid picture and
 *    is in fact the picture.
 * 3. **The plot is square and both axes carry the same fixed scale**, so a
 *    sideways distance is worth exactly what an upwards distance is worth. The
 *    engineer scatter cannot promise that, because its two axes crop separately.
 *
 * Bubble **area** — not radius — is proportional to the engineers a squad has in
 * metrics. Radius sizing squares the count on the way to the eye and would draw a
 * squad of four as four times the weight of a squad of one rather than twice it.
 *
 * The clustering is the hard part and it is real: on throughput against flow,
 * three squads sit at exactly (100, 100) and (100, 98) — identical positions with
 * near-identical bubble sizes, which is one bubble on screen. Rather than let them
 * merge, squads whose marks would bury each other are **fanned out around their
 * shared position**, a `+` in the reference colour marks the true position they
 * share, and the table underneath carries every value as a number. The fan moves a
 * bubble by at most about three and a half points of score, which is why it is
 * announced rather than done quietly, and why nothing here asks to be read off the
 * axis to a precision it does not have.
 */

export type SquadScatterDimension = 'throughput' | 'flow' | 'quality' | 'collaboration'

/**
 * One squad. Mirrors the four sub-scores on `SquadOutlier` plus the headcount the
 * bubble is sized by; `null` on a dimension means not measured and is never a 0.
 */
export type SquadScatterRow = {
  key: string
  name: string
  /** Engineers in metrics. Bubble area is proportional to this. */
  headcount: number
  throughput: number | null
  flow: number | null
  quality: number | null
  collaboration: number | null
  /** False for thin confidence — drawn hollow, never in a second colour. */
  solid: boolean
  confidenceNote: string | null
}

export type SquadScatterProps = {
  rows: SquadScatterRow[]
  /** Dimension on the across axis. Defaults to throughput. */
  initialX?: SquadScatterDimension
  /** Dimension on the up axis. Defaults to flow. */
  initialY?: SquadScatterDimension
}

const DIMENSIONS: Record<SquadScatterDimension, { label: string; rubric: string }> = {
  throughput: { label: 'Throughput', rubric: '4 MRs/eng/wk and 5 releases/wk is 100' },
  flow: { label: 'Flow', rubric: '24h cycle time is 100, 120h is 0' },
  quality: { label: 'Quality', rubric: '15% change failure and 4h to restore is 100' },
  collaboration: { label: 'Collaboration', rubric: '90% review coverage and 8 reviews/eng/wk is 100' },
}

const ORDER: SquadScatterDimension[] = ['throughput', 'flow', 'quality', 'collaboration']

// Square plot: both axes are the same fixed 0-100, so equal pixels per point is
// the honest layout and lets a diagonal be read as a diagonal.
const PLOT = 520
// Generous top and right padding: a bubble centred on 100 legitimately reaches
// past the end of the scale, and the fan pushes it further, so the room has to be
// there or the corner clips.
const PAD = { top: 58, right: 72, bottom: 58, left: 52 }
const W = PLOT + PAD.left + PAD.right
const H = PLOT + PAD.top + PAD.bottom

const MAX_R = 20
/** Centre-to-centre separation a fanned group aims for, in units of its largest radius. */
const FAN_SEPARATION = 1.4

type Placed = {
  row: SquadScatterRow
  x: number
  y: number
  /** True position in plot coordinates. */
  tx: number
  ty: number
  /** Drawn position — equal to the true one unless the mark was fanned. */
  cx: number
  cy: number
  r: number
  /** Index of the fanned group this belongs to, or null when it stands alone. */
  group: number | null
}

export function SquadScatter({ rows, initialX = 'throughput', initialY = 'flow' }: SquadScatterProps) {
  const [xKey, setXKey] = useState<SquadScatterDimension>(initialX)
  const [yKey, setYKey] = useState<SquadScatterDimension>(initialY === initialX ? 'flow' : initialY)
  const [active, setActive] = useState<string | null>(null)

  const domain = absoluteDomain()
  const px = (v: number) => PAD.left + fractionIn(v, domain) * PLOT
  const py = (v: number) => PAD.top + PLOT - fractionIn(v, domain) * PLOT

  // A squad with nobody in metrics cannot be sized by area at all, and there is no
  // honest radius to give it, so it is named underneath rather than drawn small.
  const sizeable = rows.filter((r) => r.headcount > 0)
  const unsizeable = rows.filter((r) => r.headcount <= 0)
  const maxHeadcount = Math.max(...sizeable.map((r) => r.headcount), 1)

  const { placed: pairs, absent } = measuredPairs(
    sizeable,
    (r) => r[xKey],
    (r) => r[yKey],
  )

  function choose(axis: 'x' | 'y', dimension: SquadScatterDimension) {
    // Picking what is already on the other axis swaps them, which is what someone
    // reaching for it means.
    if (axis === 'x') {
      if (dimension === yKey) setYKey(xKey)
      setXKey(dimension)
    } else {
      if (dimension === xKey) setXKey(yKey)
      setYKey(dimension)
    }
  }

  const picker = (
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      <AxisPicker axis="x" legend="Across" current={xKey} onPick={choose} />
      <AxisPicker axis="y" legend="Up" current={yKey} onPick={choose} />
    </div>
  )

  if (pairs.length === 0) {
    return (
      <div>
        {picker}
        <p className="py-8 text-center text-sm text-[var(--color-muted)]">
          No squad has a score on both {DIMENSIONS[xKey].label.toLowerCase()} and{' '}
          {DIMENSIONS[yKey].label.toLowerCase()} in this period.
        </p>
      </div>
    )
  }

  const marks: Placed[] = pairs.map(({ item, x, y }) => ({
    row: item,
    x,
    y,
    tx: px(x),
    ty: py(y),
    cx: px(x),
    cy: py(y),
    r: bubbleRadius(item.headcount, maxHeadcount, MAX_R),
    group: null,
  }))

  const groups = fanOut(marks)

  // Small bubbles last, so a big one can never sit on top of a small one — and the
  // hit targets follow the same order, so the small mark also wins the pointer.
  const drawOrder = [...marks].sort((a, b) => b.r - a.r)
  // The fixed captions are obstacles for the names, not decoration to draw over.
  const labels = placeLabels(marks, groups, [
    { left: PAD.left + PLOT - 132, right: PAD.left + PLOT, top: 4, bottom: 18 },
    { left: px(TARGET_MIDPOINT) + 3, right: px(TARGET_MIDPOINT) + 82, top: PAD.top - 18, bottom: PAD.top - 4 },
    { left: PAD.left + 2, right: PAD.left + 66, top: PAD.top + PLOT - 18, bottom: PAD.top + PLOT - 4 },
  ])
  const hovered = marks.find((m) => m.row.key === active) ?? null
  const xLabel = DIMENSIONS[xKey].label
  const yLabel = DIMENSIONS[yKey].label

  return (
    <div>
      {picker}

      <div className="relative mt-5">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`${yLabel} against ${xLabel} for ${marks.length} squads, both scored 0 to 100 against absolute targets`}
        >
          {/* --- grid, recessive, always the full 0-100 ------------------------ */}
          {ticksIn(domain).map((t) => (
            <g key={`x${t}`}>
              <line
                x1={px(t)}
                x2={px(t)}
                y1={PAD.top}
                y2={PAD.top + PLOT}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              <text
                x={px(t)}
                y={PAD.top + PLOT + 17}
                textAnchor="middle"
                className="tnum fill-[var(--color-muted)] text-[10px]"
              >
                {t}
              </text>
            </g>
          ))}
          {ticksIn(domain).map((t) => (
            <g key={`y${t}`}>
              <line
                x1={PAD.left}
                x2={PAD.left + PLOT}
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

          {/* --- the target midpoint, which is what 50 means here -------------- */}
          <line
            x1={px(TARGET_MIDPOINT)}
            x2={px(TARGET_MIDPOINT)}
            y1={PAD.top}
            y2={PAD.top + PLOT}
            stroke="var(--chart-ref)"
            strokeWidth={1}
          />
          <line
            x1={PAD.left}
            x2={PAD.left + PLOT}
            y1={py(TARGET_MIDPOINT)}
            y2={py(TARGET_MIDPOINT)}
            stroke="var(--chart-ref)"
            strokeWidth={1}
          />
          <text
            x={px(TARGET_MIDPOINT) + 5}
            y={PAD.top - 8}
            className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
          >
            target midpoint
          </text>
          {/* Named outside the plot, because with this data the bubbles are sitting
              in the top-right corner and a caption there would be underneath them. */}
          <text
            x={PAD.left + PLOT}
            y={14}
            textAnchor="end"
            className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
          >
            top right meets both targets
          </text>
          <text
            x={PAD.left + 4}
            y={PAD.top + PLOT - 8}
            className="fill-[var(--color-muted)] text-[9px] uppercase tracking-wide"
          >
            misses both
          </text>

          {/* --- axis rules. Only two, so a bubble centred on 100 can hang over
                  the edge of the scale instead of being clipped by a frame. ---- */}
          <line
            x1={PAD.left}
            x2={PAD.left + PLOT}
            y1={PAD.top + PLOT}
            y2={PAD.top + PLOT}
            stroke="var(--chart-axis)"
            strokeWidth={1}
          />
          <line
            x1={PAD.left}
            x2={PAD.left}
            y1={PAD.top}
            y2={PAD.top + PLOT}
            stroke="var(--chart-axis)"
            strokeWidth={1}
          />
          <text
            x={PAD.left + PLOT / 2}
            y={H - 22}
            textAnchor="middle"
            className="fill-[var(--color-muted)] text-[11px]"
          >
            {xLabel} against target →
          </text>
          <text
            x={PAD.left + PLOT / 2}
            y={H - 8}
            textAnchor="middle"
            className="fill-[var(--color-muted)] text-[9px]"
          >
            0 is the bad threshold, 100 the good one · {DIMENSIONS[xKey].rubric}
          </text>
          <text
            transform={`rotate(-90 12 ${PAD.top + PLOT / 2})`}
            x={12}
            y={PAD.top + PLOT / 2}
            textAnchor="middle"
            className="fill-[var(--color-muted)] text-[11px]"
          >
            {yLabel} against target →
          </text>

          {/* --- the bubbles -------------------------------------------------- */}
          {drawOrder.map((m) => {
            const dim = active !== null && m.row.key !== active
            return (
              <g key={m.row.key}>
                {/* A surface-coloured halo either side of the outline rather than an
                    opaque disc: overlapping bubbles stay countable, and none of
                    them hides the one behind. */}
                <circle
                  cx={m.cx}
                  cy={m.cy}
                  r={m.r}
                  fill="none"
                  stroke="var(--color-surface)"
                  strokeWidth={4}
                  opacity={dim ? 0.5 : 1}
                />
                <circle
                  cx={m.cx}
                  cy={m.cy}
                  r={m.r}
                  fill={m.row.solid ? 'var(--chart-series)' : 'none'}
                  fillOpacity={0.3}
                  stroke="var(--chart-series)"
                  strokeWidth={m.row.solid ? 1.5 : 2}
                  opacity={dim ? 0.3 : 1}
                />
                {m.row.key === active ? (
                  <circle
                    cx={m.cx}
                    cy={m.cy}
                    r={m.r + 5}
                    fill="none"
                    stroke="var(--chart-series)"
                    strokeWidth={1.5}
                    opacity={0.55}
                  />
                ) : null}
              </g>
            )
          })}

          {/* --- where a fanned group really sits ----------------------------- */}
          {groups.map((g, i) => (
            <g key={`fan${i}`} opacity={active === null ? 1 : 0.55}>
              {/* Drawn over the fills, so a halo underneath is what makes it read. */}
              <path
                d={`M ${g.cx - 6} ${g.cy} H ${g.cx + 6} M ${g.cx} ${g.cy - 6} V ${g.cy + 6}`}
                stroke="var(--color-surface)"
                strokeWidth={4}
                strokeLinecap="round"
              />
              <path
                d={`M ${g.cx - 6} ${g.cy} H ${g.cx + 6} M ${g.cx} ${g.cy - 6} V ${g.cy + 6}`}
                stroke="var(--chart-ref)"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            </g>
          ))}

          {/* --- names, then hit targets, above every fill -------------------- */}
          {drawOrder.flatMap((m) => {
            const label = labels.get(m.row.key)
            if (!label) return []
            const fade = active !== null && m.row.key !== active ? 0.4 : 1
            return [
              <g key={`t${m.row.key}`} opacity={fade}>
                {label.leader ? (
                  <line
                    x1={label.leader.x1}
                    y1={label.leader.y1}
                    x2={label.leader.x2}
                    y2={label.leader.y2}
                    stroke="var(--chart-ref)"
                    strokeWidth={1}
                  />
                ) : null}
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  className="fill-[var(--color-ink)] text-[10px]"
                >
                  {m.row.name}
                </text>
              </g>,
            ]
          })}
          {drawOrder.map((m) => (
            <circle
              key={`h${m.row.key}`}
              cx={m.cx}
              cy={m.cy}
              r={Math.max(12, m.r)}
              fill="transparent"
              tabIndex={0}
              role="button"
              aria-label={`${m.row.name}, ${m.row.headcount} in metrics, ${xLabel} ${m.x.toFixed(1)} of 100, ${yLabel} ${m.y.toFixed(1)} of 100${
                m.group === null ? '' : ', drawn fanned out from a position it shares'
              }`}
              className="cursor-pointer outline-none focus-visible:stroke-[var(--color-ink)]"
              onMouseEnter={() => setActive(m.row.key)}
              onMouseLeave={() => setActive((c) => (c === m.row.key ? null : c))}
              onFocus={() => setActive(m.row.key)}
              onBlur={() => setActive((c) => (c === m.row.key ? null : c))}
            />
          ))}
        </svg>

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
            <p className="text-xs font-semibold">{hovered.row.name}</p>
            <p className="tnum mt-0.5 text-[11px] text-[var(--color-muted)]">
              {hovered.row.headcount} {hovered.row.headcount === 1 ? 'engineer' : 'engineers'} in
              metrics
            </p>
            <dl className="mt-2 space-y-1">
              <Row label={xLabel} value={hovered.x} />
              <Row label={yLabel} value={hovered.y} />
            </dl>
            {hovered.group !== null ? (
              <p className="mt-2 border-t border-[var(--color-line)] pt-1.5 text-[10px] text-[var(--color-muted)]">
                Drawn fanned out from the marked position it effectively shares with another squad.
                Its own scores are the two numbers above.
              </p>
            ) : null}
            {hovered.row.confidenceNote ? (
              <p className="mt-2 border-t border-[var(--color-line)] pt-1.5 text-[10px] text-[var(--color-muted)]">
                {hovered.row.confidenceNote}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <Legend
        maxHeadcount={maxHeadcount}
        anyHollow={marks.some((m) => !m.row.solid)}
        anyFanned={groups.length > 0}
      />

      {/* Every value on the plot, as a number. Position at this scale is ordering
          more than magnitude, and a fanned bubble is a few points off where it
          says it is — the table is what nobody has to hover to read. */}
      <table className="mt-4 w-full min-w-0 border-collapse text-left">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            <th className="pb-1 font-medium">Squad</th>
            <th className="pb-1 text-right font-medium">In metrics</th>
            <th className="pb-1 text-right font-medium">{xLabel}</th>
            <th className="pb-1 text-right font-medium">{yLabel}</th>
          </tr>
        </thead>
        <tbody>
          {[...marks]
            .sort((a, b) => (b.x + b.y) / 2 - (a.x + a.y) / 2)
            .map((m) => (
              <tr key={m.row.key} className="border-t border-[var(--color-line)]">
                <td className="py-1.5 text-xs">{m.row.name}</td>
                <td className="tnum py-1.5 text-right text-xs text-[var(--color-muted)]">
                  {m.row.headcount}
                </td>
                <td className="tnum py-1.5 text-right text-xs">{m.x.toFixed(1)}</td>
                <td className="tnum py-1.5 text-right text-xs">{m.y.toFixed(1)}</td>
              </tr>
            ))}
          {[...absent, ...unsizeable].map((row) => (
            <tr key={row.key} className="border-t border-[var(--color-line)]">
              <td className="py-1.5 text-xs text-[var(--color-muted)]">{row.name}</td>
              <td className="tnum py-1.5 text-right text-xs text-[var(--color-muted)]">
                {row.headcount}
              </td>
              <td className="py-1.5 text-right text-xs text-[var(--color-muted)]" colSpan={2}>
                {row.headcount <= 0
                  ? 'nobody in metrics — no area to size a bubble by'
                  : 'no data on one of these dimensions'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <MetricNote>
        Both axes are the <strong>fixed full 0-100</strong> and never crop to the data: 0 is the
        bad threshold, 100 is the good one, and the two lines are genuinely halfway between them
        rather than the median of the other squads. That is the difference from the engineer
        charts, and it is why every squad can sit top-right — a strong org should not manufacture
        a loser. It is also why the picture is a cluster against the ceiling: squads clear flow and
        collaboration comfortably, so the dimensions that separate them are throughput and quality,
        and everything else is agreement rather than a tie to be broken.{' '}
        <strong>Bubble area</strong> — not width — is the engineers a squad has in metrics, because
        sizing by width would square the count and draw a squad of four as four times the weight of
        a squad of one.
        {groups.length > 0 ? (
          <>
            {' '}
            Where squads land on effectively the same spot their bubbles are{' '}
            <strong>fanned out</strong> around it, a <span className="text-[var(--color-ink)]">+</span>{' '}
            marks the position they share, and a line ties each name to its own bubble. The fan
            moves a bubble by up to{' '}
            <span className="tnum">
              {Math.max(...groups.map((g) => g.shift)).toFixed(1)} points
            </span>{' '}
            here, so read the table rather than the axis for those.
          </>
        ) : null}
        {absent.length > 0 ? (
          <>
            {' '}
            {absent.length === 1 ? 'One squad is' : `${absent.length} squads are`} not plotted: a
            dimension with no data drops out of the score instead of counting as zero, so there is
            nothing to place them at — and 0 here would read as failing a target nobody measured.
          </>
        ) : null}
      </MetricNote>
    </div>
  )
}

/**
 * Fan apart the marks that would bury each other, and report the shared positions.
 *
 * Mutates `cx`/`cy`/`group` in place; the true position stays on `tx`/`ty`. A mark
 * buries another when its centre falls well inside it, which at this scale is
 * routine rather than unlucky — three squads score exactly 100 on throughput.
 * Marks that merely overlap are left where they are: the surface halo keeps two
 * overlapping outlines countable, and moving a mark that did not need moving costs
 * accuracy for nothing.
 */
function fanOut(marks: Placed[]): { cx: number; cy: number; size: number; shift: number }[] {
  const parent = marks.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i]!
      const b = marks[j]!
      const gap = Math.hypot(a.tx - b.tx, a.ty - b.ty)
      if (gap < 0.85 * Math.min(a.r, b.r)) parent[find(i)] = find(j)
    }
  }

  const buckets = new Map<number, number[]>()
  for (let i = 0; i < marks.length; i++) {
    const root = find(i)
    const bucket = buckets.get(root)
    if (bucket) bucket.push(i)
    else buckets.set(root, [i])
  }

  const shared: { cx: number; cy: number; size: number; shift: number }[] = []
  for (const members of buckets.values()) {
    if (members.length < 2) continue
    const n = members.length
    const cx = members.reduce((sum, i) => sum + marks[i]!.tx, 0) / n
    const cy = members.reduce((sum, i) => sum + marks[i]!.ty, 0) / n
    const maxR = Math.max(...members.map((i) => marks[i]!.r))
    // Enough radius that every centre lands outside its neighbours' outlines.
    const fanR = (FAN_SEPARATION * maxR) / (2 * Math.sin(Math.PI / n))
    // Open the fan towards the middle of the plot, where there is room for it.
    const start = Math.atan2(PAD.top + PLOT / 2 - cy, PAD.left + PLOT / 2 - cx)
    const group = shared.length
    members
      // Biggest bubble first, so the fan's opening slot goes to the mark that most
      // needs the room rather than to whichever squad happened to be sorted first.
      .sort((a, b) => marks[b]!.r - marks[a]!.r)
      .forEach((i, k) => {
        const angle = start + (k * 2 * Math.PI) / n
        marks[i]!.cx = cx + fanR * Math.cos(angle)
        marks[i]!.cy = cy + fanR * Math.sin(angle)
        marks[i]!.group = group
      })
    // In score points, so the note can say how far the fan actually moved things
    // rather than quoting a worst case nobody can check.
    shared.push({ cx, cy, size: n, shift: (fanR / PLOT) * 100 })
  }
  return shared
}

type Box = { left: number; right: number; top: number; bottom: number }
type Label = {
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  /** Drawn when the name is not simply sitting under its own bubble. */
  leader: { x1: number; y1: number; x2: number; y2: number } | null
}

/**
 * Where each squad's name goes, or whether it goes anywhere.
 *
 * Same rule as the engineer scatter: **a name is only drawn where it can point at
 * one bubble.** With three squads fanned around a single corner, a name shoved
 * outward and then clamped back inside the frame ends up beside somebody else's
 * bubble, which is worse than no name at all. So each name tries a ring of
 * positions in preference order — outward from its fan first, then downward — and
 * takes the first that clears every other bubble, every name already placed, the
 * fixed captions, and the edge of the frame. Anything left over is unlabelled and
 * reachable by pointer, by keyboard, and in the table underneath.
 */
function placeLabels(
  marks: Placed[],
  groups: { cx: number; cy: number }[],
  reserved: Box[],
): Map<string, Label> {
  const out = new Map<string, Label>()
  const taken: Box[] = [...reserved]

  // Biggest bubble picks first: it is the one a reader looks at first, and it has
  // the most perimeter to hide a name behind.
  for (const m of [...marks].sort((a, b) => b.r - a.r)) {
    const g = m.group === null ? null : groups[m.group]
    let preferred = Math.PI / 2 // straight down, in SVG's y-down coordinates
    if (g) {
      const len = Math.hypot(m.cx - g.cx, m.cy - g.cy)
      if (len > 0.5) preferred = Math.atan2(m.cy - g.cy, m.cx - g.cx)
    }

    const width = m.row.name.length * 5.4 + 2
    let chosen: Label | null = null
    let chosenBox: Box | null = null

    // Close in first, further out only if nothing close in works. A fanned bubble
    // starts further out on purpose: its neighbours are a few pixels away, so its
    // name needs room for a leader line long enough to be followed.
    outer: for (const gap of m.group === null ? [9, 30] : [26, 40]) {
      for (const angle of ringOf(preferred)) {
        const dx = Math.cos(angle)
        const dy = Math.sin(angle)
        const reach = m.r + gap
        const anchor: 'start' | 'middle' | 'end' =
          dx > 0.35 ? 'start' : dx < -0.35 ? 'end' : 'middle'
        const x = m.cx + dx * reach
        const y = m.cy + dy * reach + (dy > 0.35 ? 9 : dy < -0.35 ? -4 : 3.5)
        const left = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2
        const box: Box = { left, right: left + width, top: y - 8, bottom: y + 3 }

        if (box.left < 3 || box.right > W - 3 || box.top < 2 || box.bottom > PAD.top + PLOT + 4) {
          continue
        }
        if (taken.some((t) => overlaps(box, t))) continue
        if (marks.some((o) => o.row.key !== m.row.key && coversBox(box, o))) continue

        // A fanned bubble is not where its score says it is, and its neighbours are
        // a few pixels away, so its name has to be tied to it rather than merely
        // near it. A lone bubble with its name underneath needs no such help.
        const tie = m.group !== null || gap > 14
        chosen = {
          x,
          y,
          anchor,
          leader: tie
            ? {
                x1: m.cx + dx * (m.r + 3),
                y1: m.cy + dy * (m.r + 3),
                x2: m.cx + dx * (m.r + gap - 6),
                y2: m.cy + dy * (m.r + gap - 6),
              }
            : null,
        }
        chosenBox = box
        break outer
      }
    }

    if (chosen && chosenBox) {
      out.set(m.row.key, chosen)
      taken.push(chosenBox)
    }
  }
  return out
}

/** The preferred direction first, then outward from it in alternating 30° steps. */
function ringOf(preferred: number): number[] {
  const out = [preferred]
  for (let step = 1; step <= 6; step++) {
    out.push(preferred + (step * Math.PI) / 6, preferred - (step * Math.PI) / 6)
  }
  return out
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** Whether a bubble's disc reaches into a label's box. */
function coversBox(box: Box, m: Placed): boolean {
  const nx = Math.min(Math.max(m.cx, box.left), box.right)
  const ny = Math.min(Math.max(m.cy, box.top), box.bottom)
  return Math.hypot(m.cx - nx, m.cy - ny) < m.r + 1
}

function AxisPicker({
  axis,
  legend,
  current,
  onPick,
}: {
  axis: 'x' | 'y'
  legend: string
  current: SquadScatterDimension
  onPick: (axis: 'x' | 'y', dimension: SquadScatterDimension) => void
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{legend}</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {ORDER.map((dimension) => {
          const isActive = dimension === current
          return (
            <button
              key={dimension}
              type="button"
              onClick={() => onPick(axis, dimension)}
              aria-pressed={isActive}
              className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                isActive
                  ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                  : 'border-[var(--color-line)] text-[var(--color-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {DIMENSIONS[dimension].label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** One series needs no colour key. The size scale and the second mark both need one. */
function Legend({
  maxHeadcount,
  anyHollow,
  anyFanned,
}: {
  maxHeadcount: number
  anyHollow: boolean
  anyFanned: boolean
}) {
  const small = bubbleRadius(1, maxHeadcount, MAX_R)
  const big = bubbleRadius(maxHeadcount, maxHeadcount, MAX_R)
  const box = big * 2 + 6
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-[var(--color-muted)]">
      <span className="flex items-center gap-2">
        <svg width={box * 1.6} height={box} viewBox={`0 0 ${box * 1.6} ${box}`} aria-hidden="true">
          <circle
            cx={big + 3}
            cy={box / 2}
            r={big}
            fill="var(--chart-series)"
            fillOpacity={0.3}
            stroke="var(--chart-series)"
            strokeWidth={1.5}
          />
          <circle
            cx={big * 2 + small + 5}
            cy={box / 2}
            r={small}
            fill="var(--chart-series)"
            fillOpacity={0.3}
            stroke="var(--chart-series)"
            strokeWidth={1.5}
          />
        </svg>
        <span className="tnum">
          {maxHeadcount} and 1 engineer in metrics — area, not width
        </span>
      </span>
      {anyHollow ? (
        <span className="flex items-center gap-1.5">
          <svg width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="var(--chart-series)" strokeWidth="2" />
          </svg>
          Hollow: thin data — placement is indicative
        </span>
      ) : null}
      {anyFanned ? (
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden="true">
            <line x1="2" x2="10" y1="6" y2="6" stroke="var(--chart-ref)" strokeWidth="1.25" />
            <line x1="6" x2="6" y1="2" y2="10" stroke="var(--chart-ref)" strokeWidth="1.25" />
          </svg>
          A position two or more squads effectively share — bubbles fanned around it
        </span>
      ) : null}
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-[var(--color-muted)]">{label}</dt>
      <dd className="tnum text-xs font-semibold">{value.toFixed(1)} / 100</dd>
    </div>
  )
}
