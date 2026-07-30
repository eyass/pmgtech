'use client'

import { useState } from 'react'

import {
  describeProfile,
  RADAR_AXES,
  RADAR_MAX,
  RADAR_MIN,
  RADAR_REFERENCE,
  radarPoint,
  radarRing,
  radarShape,
  REFERENCE_MEANING,
  type RadarAxisKey,
  type RadarGeometry,
  type RadarKind,
  type RadarSubject,
  type RadarReference,
} from '@/lib/radar-geometry'

/**
 * The four-dimension profile, as a shape.
 *
 * The ranked table answers "who is first"; the scatter answers "who sits apart";
 * this answers the one neither can — **what is this person shaped like**. Spiky
 * reads as specialist, balanced as generalist, and the direction of the spike
 * names the dimension carrying them. That is the only question a radar answers
 * well, so everything here is arranged to stop it answering others badly.
 *
 * Five rules, each a choice against a more flattering alternative:
 *
 * 1. **The radial scale is fixed at 0-100 and is never fitted to the data.** Every
 *    other chart in this app pads its domain (`scoreDomain`); a radar must not,
 *    because small multiples are comparable only when every chart shares an
 *    identical scale, and a fitted radius would make a cohort spanning three
 *    points fill the ring exactly like one spanning sixty. `RADAR_MIN`/`RADAR_MAX`
 *    are constants for that reason and no prop changes them.
 * 2. **The axis order is part of the contract**, not a detail:
 *    throughput → flow → quality → collaboration, clockwise from the top.
 *    Reordering the axes changes both the outline and the enclosed area of the
 *    same four numbers, so a reader who has learned one order would be misled by
 *    another. `RADAR_AXES` is the single definition and callers cannot reorder it.
 * 3. **Area is not an ordering.** The area of a radar polygon grows with the
 *    *square* of the values and depends on which axes happen to sit next to each
 *    other, so a bigger shape is not a higher score and two shapes of equal area
 *    are not a tie. Nothing here computes area, sorts by it, or implies it: the
 *    composite is printed as a number beside every chart, and that number — not
 *    the shape — is the ordering.
 * 4. **The ring at 50 is the cohort median**, not a threshold somebody chose.
 *    Engineer scores are built so 50 is the median of the engineer's own seniority
 *    level (`score_vs_cohort` in `0021_outliers.sql`), so the reference polygon
 *    falls out of the scoring rather than being drawn on top of it. It is the same
 *    `MEDIAN` the scatter and the strip plot use, imported rather than repeated.
 * 5. **The shape is never the only way to read a value.** Every chart carries an
 *    `aria-label` with all four numbers, and the numbers are rendered as text too —
 *    here as a value list beside the shape, in the small multiples as a compact
 *    figure line under each name.
 *
 * A dimension with no data behind it (DevExp has no quality score in this org's
 * 90-day window) is drawn as a gap rather than as a zero: the axis is labelled
 * "no data" and the outline closes over the axes that were measured. That makes
 * the shape smaller, which is precisely why rule 3 exists.
 *
 * The maths, the scale constants, the named sort orders and the materiality rule
 * live in `@/lib/radar-geometry`, so they can be tested and so a **server**
 * component can call them.
 *
 * Only the types are re-exported here, and that restriction is load-bearing: this
 * is a `'use client'` module, so every *value* it exports becomes a client
 * reference. A server page importing `medianProfile` through this file gets a
 * proxy and throws "Attempted to call medianProfile() from the server" at request
 * time — which is exactly what happened the first time this was rendered. Types
 * are erased at compile time and are safe to take from either module.
 */

export type {
  DimensionGap,
  GapSide,
  GapVerdict,
  OverlayCheck,
  RadarAxisKey,
  RadarGeometry,
  RadarKind,
  RadarReference,
  RadarSortKey,
  RadarSubject,
  RadarValues,
  RadarVertex,
  ScoreGap,
} from '@/lib/radar-geometry'

// --- sizes ------------------------------------------------------------------

/**
 * Two sizes and no more. `md` is a chart in its own right with worded axes; `sm`
 * is a small multiple, where the axis words cannot be drawn at a legible size and
 * are replaced by initials that the grid's legend expands once. Anything between
 * the two would just be an illegible `md`.
 */
export type RadarSize = 'md' | 'sm'

const SIZES = {
  // `padX` is sized for the widest axis word, "Collaboration", so the labels —
  // which are pinned to the viewBox edges — always clear the outer ring.
  md: { radius: 96, padX: 90, padY: 32, axisFont: 11, showTicks: true, strokeWidth: 2 },
  sm: { radius: 42, padX: 16, padY: 16, axisFont: 9, showTicks: false, strokeWidth: 1.5 },
} as const

export function radarFrame(size: RadarSize) {
  const s = SIZES[size]
  return {
    ...s,
    width: s.radius * 2 + s.padX * 2,
    height: s.radius * 2 + s.padY * 2,
    geometry: { cx: s.radius + s.padX, cy: s.radius + s.padY, radius: s.radius } as RadarGeometry,
  }
}

// --- shared SVG pieces ------------------------------------------------------

/**
 * Rings, spokes, the median reference and the axis names.
 *
 * Exported because the head-to-head view draws the same frame under two shapes,
 * and a second copy of this would be a second chance for two charts on one page
 * to disagree about their own scale.
 */
export function RadarFrame({
  size,
  activeAxis,
  missing,
  reference,
}: {
  size: RadarSize
  /** Dims the other axis names rather than brightening this one. */
  activeAxis?: RadarAxisKey | null
  /** Axes to mark "no data" beside. */
  missing?: RadarAxisKey[]
  reference?: RadarReference
}) {
  const { geometry, axisFont, width, height, padY } = radarFrame(size)
  const { cx, cy } = geometry
  const refShape = reference ? radarShape(reference.values, geometry) : null

  return (
    <>
      {/* --- grid rings, recessive ------------------------------------------- */}
      {[25, 75, RADAR_MAX].map((v) => (
        <polygon
          key={v}
          points={radarRing(v, geometry)}
          fill="none"
          stroke="var(--chart-grid)"
          strokeWidth={1}
        />
      ))}

      {/* --- spokes ---------------------------------------------------------- */}
      {RADAR_AXES.map((axis) => {
        const end = radarPoint(axis.key, RADAR_MAX, geometry)
        return (
          <line
            key={axis.key}
            x1={cx}
            y1={cy}
            x2={end.x}
            y2={end.y}
            stroke="var(--chart-grid)"
            strokeWidth={1}
          />
        )
      })}

      {/* --- 50, which is the cohort median rather than a midpoint ------------ */}
      <polygon
        points={radarRing(RADAR_REFERENCE, geometry)}
        fill="none"
        stroke="var(--chart-ref)"
        strokeWidth={1}
      />

      {/* --- the cohort's own median shape, when one was supplied -------------
          A filled region rather than another outline: this is a backdrop the
          subject sits against, not a third series competing with them, and it
          deliberately has no vertices so it cannot be counted as one. */}
      {refShape && refShape.points ? (
        <polygon
          points={refShape.points}
          fill="var(--chart-ref)"
          fillOpacity={0.18}
          stroke="var(--chart-ref)"
          strokeWidth={1.25}
        />
      ) : null}

      {/* --- axis names, pinned to the viewBox edges so they cannot clip ------ */}
      {RADAR_AXES.map((axis) => {
        const dim = activeAxis != null && activeAxis !== axis.key
        const isMissing = missing?.includes(axis.key) ?? false
        const text = size === 'sm' ? axis.short : axis.label
        const common = {
          className: 'fill-[var(--color-ink)]',
          opacity: dim ? 0.4 : 1,
          fontSize: axisFont,
        }
        if (axis.key === 'throughput') {
          return (
            <g key={axis.key}>
              <text x={cx} y={padY - 9} textAnchor="middle" {...common}>
                {text}
              </text>
              {isMissing ? <NoData x={cx} y={padY - 1} anchor="middle" /> : null}
            </g>
          )
        }
        if (axis.key === 'quality') {
          return (
            <g key={axis.key}>
              <text x={cx} y={height - padY + axisFont + 6} textAnchor="middle" {...common}>
                {text}
              </text>
              {isMissing ? (
                <NoData x={cx} y={height - padY + axisFont * 2 + 8} anchor="middle" />
              ) : null}
            </g>
          )
        }
        const right = axis.key === 'flow'
        const x = right ? width - 4 : 4
        return (
          <g key={axis.key}>
            <text x={x} y={cy - 2} textAnchor={right ? 'end' : 'start'} {...common}>
              {text}
            </text>
            {isMissing ? (
              <NoData x={x} y={cy + axisFont} anchor={right ? 'end' : 'start'} />
            ) : null}
          </g>
        )
      })}
    </>
  )
}

/**
 * The 0 / 50 / 100 tick labels, on the throughput spoke.
 *
 * A separate component from `RadarFrame` and rendered **after** the shapes, because
 * the spoke is exactly where a subject's outline and vertices land: at radius 96 a
 * throughput of 100 puts a vertex straight through the "100", and a tick drawn
 * under the shape is a tick nobody can read. Each label also carries a
 * surface-coloured halo (`paintOrder: stroke`) so it survives sitting on a stroke.
 */
export function RadarTicks({ size }: { size: RadarSize }) {
  const { geometry, radius, showTicks } = radarFrame(size)
  if (!showTicks) return null
  return (
    <>
      {[RADAR_MIN, RADAR_REFERENCE, RADAR_MAX].map((tick) => (
        <text
          key={tick}
          x={geometry.cx + 6}
          y={geometry.cy - (radius * tick) / RADAR_MAX + (tick === RADAR_MIN ? -3 : 3)}
          className="tnum fill-[var(--color-muted)] text-[9px]"
          stroke="var(--color-surface)"
          strokeWidth={2.5}
          style={{ paintOrder: 'stroke' }}
        >
          {tick}
        </text>
      ))}
    </>
  )
}

function NoData({ x, y, anchor }: { x: number; y: number; anchor: 'middle' | 'start' | 'end' }) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      className="fill-[var(--color-muted)] text-[8px] uppercase tracking-wide"
    >
      no data
    </text>
  )
}

/** Which of the two overlay slots a shape is drawn in. */
export type RadarSlot = 'a' | 'b'

/**
 * One subject's outline.
 *
 * Slot `a` is solid-stroked, filled, and has circular vertices; slot `b` is
 * long-dashed, barely filled, and has diamond vertices. The two slots differ by
 * hue **and** dash pattern **and** vertex shape, so the pair survives greyscale, a
 * monochrome printer and every form of colour-vision deficiency. A hue-only pair
 * would not: the two series hues are within 4 L* of each other on purpose, so
 * neither polygon reads as heavier than the other, which is exactly the condition
 * under which hue alone fails.
 *
 * Thin confidence hollows the vertices — the same mark the scatter and the strip
 * plot use — and in the single-subject chart it also drops the fill. In the
 * two-shape compare the fill is already carrying the slot, so there hollow
 * vertices plus the named caveat in the legend do the work.
 */
export function RadarShape({
  subject,
  size,
  slot = 'a',
  geometry,
  interactive = false,
  activeAxis = null,
  onAxis,
}: {
  subject: RadarSubject
  size: RadarSize
  slot?: RadarSlot
  geometry: RadarGeometry
  /** Adds 24px vertex hit targets answering to hover and keyboard focus alike. */
  interactive?: boolean
  activeAxis?: RadarAxisKey | null
  onAxis?: (axis: RadarAxisKey | null) => void
}) {
  const colour = slot === 'a' ? 'var(--chart-series)' : 'var(--chart-series-2)'
  const { vertices, points } = radarShape(subject.values, geometry)
  const stroke = radarFrame(size).strokeWidth
  const dash = slot === 'b' ? '7 4' : undefined
  const fillOpacity = slot === 'b' ? 0.1 : subject.solid ? 0.16 : 0

  return (
    <g>
      {points ? (
        <polygon
          points={points}
          fill={colour}
          fillOpacity={fillOpacity}
          stroke={colour}
          strokeWidth={stroke}
          strokeDasharray={dash}
          strokeLinejoin="round"
        />
      ) : null}
      {vertices.map((v) => {
        const dim = activeAxis != null && activeAxis !== v.axis
        return (
          <g key={v.axis} opacity={dim ? 0.35 : 1}>
            {/* A surface-coloured backing keeps two coincident vertices countable. */}
            <Vertex
              x={v.x}
              y={v.y}
              slot={slot}
              r={size === 'sm' ? 3.4 : 4.6}
              fill="var(--color-surface)"
            />
            <Vertex
              x={v.x}
              y={v.y}
              slot={slot}
              r={size === 'sm' ? 2.4 : 3.4}
              fill={subject.solid ? colour : 'var(--color-surface)'}
              stroke={colour}
              strokeWidth={subject.solid ? 0 : 1.75}
            />
            {interactive ? (
              <circle
                cx={v.x}
                cy={v.y}
                r={12}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${subject.name}, ${v.label} ${v.value.toFixed(1)} of 100`}
                className="cursor-pointer outline-none focus-visible:stroke-[var(--color-ink)]"
                onMouseEnter={() => onAxis?.(v.axis)}
                onMouseLeave={() => onAxis?.(null)}
                onFocus={() => onAxis?.(v.axis)}
                onBlur={() => onAxis?.(null)}
              />
            ) : null}
          </g>
        )
      })}
    </g>
  )
}

/** Circle for slot a, diamond for slot b — the greyscale half of the distinction. */
function Vertex({
  x,
  y,
  slot,
  r,
  fill,
  stroke,
  strokeWidth,
}: {
  x: number
  y: number
  slot: RadarSlot
  r: number
  fill: string
  stroke?: string
  strokeWidth?: number
}) {
  if (slot === 'a') {
    return <circle cx={x} cy={y} r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  }
  const d = r * 1.3
  return (
    <polygon
      points={`${x},${y - d} ${x + d},${y} ${x},${y + d} ${x - d},${y}`}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  )
}

// --- the single-subject chart -----------------------------------------------

export type RadarProps = {
  subject: RadarSubject
  /** The shape to sit them against — the median of their own level, usually. */
  reference?: RadarReference
  size?: RadarSize
  /** Changes what the chart says 50 means. Engineers: a cohort median. Squads: a target. */
  kind?: RadarKind
  /** Hides the value list; only for callers that print the numbers themselves. */
  hideValues?: boolean
  className?: string
}

/**
 * One subject's four-dimension profile.
 *
 * The composite is printed beside the shape rather than encoded in it, because the
 * area of the polygon is not an ordering — rule 3 in the file comment. The value
 * list is the same data as the shape and is also the hover and focus readout, so
 * the shape enhances and never gates.
 */
export function Radar({
  subject,
  reference,
  size = 'md',
  kind = 'engineers',
  hideValues = false,
  className = '',
}: RadarProps) {
  const [activeAxis, setActiveAxis] = useState<RadarAxisKey | null>(null)
  const { width, height, geometry } = radarFrame(size)
  const { missing } = radarShape(subject.values, geometry)

  return (
    <div className={`flex flex-wrap items-start gap-x-6 gap-y-3 ${className}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full max-w-[330px] shrink-0"
        role="img"
        aria-label={describeProfile(subject)}
      >
        <RadarFrame size={size} activeAxis={activeAxis} missing={missing} reference={reference} />
        <RadarShape
          subject={subject}
          size={size}
          geometry={geometry}
          interactive
          activeAxis={activeAxis}
          onAxis={setActiveAxis}
        />
        <RadarTicks size={size} />
      </svg>

      {hideValues ? null : (
        // Capped, so the numbers stay next to the shape they belong to rather than
        // being pushed to the far edge of a wide card.
        <div className="min-w-[11rem] max-w-[24rem] flex-1">
          <p className="text-sm font-semibold">{subject.name}</p>
          {subject.meta ? (
            <p className="text-[11px] text-[var(--color-muted)]">{subject.meta}</p>
          ) : null}

          {/* The composite as a number. This, not the shape, is the ordering. */}
          <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5">
            <span className="tnum text-2xl font-semibold">
              {subject.score === null ? '—' : subject.score.toFixed(1)}
            </span>
            <span className="text-[11px] text-[var(--color-muted)]">
              composite · {RADAR_REFERENCE} is {REFERENCE_MEANING[kind]}
            </span>
          </p>

          <dl className="mt-2 space-y-1">
            {RADAR_AXES.map((axis) => {
              const value = subject.values[axis.key]
              const dim = activeAxis != null && activeAxis !== axis.key
              return (
                <div
                  key={axis.key}
                  className="flex items-baseline justify-between gap-3"
                  style={{ opacity: dim ? 0.45 : 1 }}
                >
                  <dt className="text-[11px] text-[var(--color-muted)]">{axis.label}</dt>
                  <dd className="tnum text-xs font-semibold">
                    {value === null ? (
                      <span className="font-normal text-[var(--color-muted)]">no data</span>
                    ) : (
                      value.toFixed(1)
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>

          {reference ? (
            <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-snug text-[var(--color-muted)]">
              <svg width="12" height="12" aria-hidden="true" className="mt-0.5 shrink-0">
                <rect
                  x="1"
                  y="1"
                  width="10"
                  height="10"
                  fill="var(--chart-ref)"
                  fillOpacity="0.18"
                  stroke="var(--chart-ref)"
                />
              </svg>
              <span>
                {reference.label}
                {reference.detail ? ` — ${reference.detail}` : ''}
              </span>
            </p>
          ) : null}

          {subject.solid ? null : (
            <p className="mt-2 text-[10px] leading-snug text-amber-600 dark:text-amber-400">
              Hollow points:{' '}
              {subject.note ?? 'thin data or no cohort — the shape is indicative'}
            </p>
          )}

          <p className="mt-2 border-t border-[var(--color-line)] pt-1.5 text-[10px] leading-relaxed text-[var(--color-muted)]">
            Fixed 0-100 scale. A bigger shape is not a higher score — polygon area grows
            with the square of the values and changes if the axes are reordered, so read
            the composite for placing and the shape only for which dimensions produced it.
          </p>
        </div>
      )}
    </div>
  )
}
