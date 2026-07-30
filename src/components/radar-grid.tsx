'use client'

import { useState } from 'react'

import { radarFrame, RadarFrame, RadarShape } from '@/components/radar'
import {
  describeProfile,
  RADAR_AXES,
  RADAR_REFERENCE,
  RADAR_SORTS,
  radarShape,
  REFERENCE_MEANING,
  type RadarKind,
  type RadarReference,
  type RadarSortKey,
  type RadarSubject,
} from '@/lib/radar-geometry'

/**
 * Small multiples of the four-dimension profile — one radar per subject.
 *
 * This is the only view in the app for scanning **shape across a whole cohort**.
 * The ranked table orders people, the scatter places them on two dimensions at a
 * time, and neither shows you that one engineer is a spike on flow while another
 * is a square. Read down the grid for outline, not for size.
 *
 * What makes small multiples work is the thing that makes them worth building:
 * **every chart is on an identical fixed 0-100 scale**, so two shapes are
 * comparable by superposition. A per-chart fitted radius would make this grid
 * actively misleading, which is why `Radar` has no way to fit one.
 *
 * Three sizing and ordering decisions:
 *
 * - **Each chart is small enough that a full engineering org fits without
 *   scrolling sideways.** At 14 people the grid is two rows on a laptop. The
 *   axis words do not survive that size, so the axes are initialled and the
 *   legend above the grid expands them once rather than fourteen times.
 * - **Order is the parent's decision, not this component's.** `/rankings` drives
 *   it, because the useful order changes with the question: by composite to see
 *   whether shape tracks the ranking, by spread to pull the specialists to the
 *   front, by name to find a person.
 * - **The four numbers are printed under every name.** At this size the shape is
 *   an index, not a readout, and a chart whose only readable channel is a
 *   120px polygon is not accessible.
 */

// `RadarSortKey`, `RADAR_SORTS` and `RADAR_SORT_LABELS` live in
// `@/lib/radar-geometry` rather than here, because a server page needs them to
// validate a URL parameter, and a value exported from a `'use client'` module is a
// client reference the server cannot call.
export type { RadarSortKey } from '@/lib/radar-geometry'

export type RadarGridProps = {
  subjects: RadarSubject[]
  /** Which named order to draw in. Defaults to composite score. */
  sort?: RadarSortKey
  /**
   * A shape drawn under every chart in the grid — the org or level median,
   * usually. One reference for the whole grid, because a different backdrop per
   * cell would break the superposition the grid exists for.
   */
  reference?: RadarReference
  /** Changes what the legend says 50 means: a cohort median, or a target midpoint. */
  kind?: RadarKind
  /** Shown when there is nothing to draw. */
  empty?: string
  className?: string
}

export function RadarGrid({
  subjects,
  sort = 'score',
  reference,
  kind = 'engineers',
  empty = 'Nobody has a scored profile in this period.',
  className = '',
}: RadarGridProps) {
  const [active, setActive] = useState<string | null>(null)

  if (subjects.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--color-muted)]">{empty}</p>
  }

  const ordered = [...subjects].sort(RADAR_SORTS[sort])
  const anyThin = ordered.some((s) => !s.solid)

  return (
    <div className={className}>
      {/* One legend for the whole grid: the axis words do not fit in the cells. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-muted)]">
        <span className="tnum">
          {RADAR_AXES.map((a) => `${a.short} ${a.label.toLowerCase()}`).join(' · ')}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--chart-ref)" />
          </svg>
          inner ring is {RADAR_REFERENCE}, {REFERENCE_MEANING[kind]}
        </span>
        {reference ? (
          <span className="flex items-center gap-1.5">
            <svg width="12" height="12" aria-hidden="true">
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
            {reference.label}
          </span>
        ) : null}
        {anyThin ? (
          <span className="flex items-center gap-1.5">
            <svg width="12" height="12" aria-hidden="true">
              <circle cx="6" cy="6" r="3" fill="var(--color-surface)" stroke="var(--chart-series)" strokeWidth="1.75" />
            </svg>
            hollow points are thin data
          </span>
        ) : null}
      </div>

      {/* auto-fill at 8.5rem keeps ~7 across a laptop, so 14 people are two rows
          and nothing ever scrolls sideways. */}
      <ul
        className="grid list-none gap-x-3 gap-y-4"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(8.5rem, 1fr))' }}
      >
        {ordered.map((subject) => (
          <Cell
            key={subject.id}
            subject={subject}
            reference={reference}
            dim={active !== null && active !== subject.id}
            onActive={setActive}
          />
        ))}
      </ul>

      <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
        Every chart is on the same fixed 0-100 scale, so the shapes are comparable by
        outline. They are <em>not</em> comparable by size: the area of a radar polygon grows
        with the square of the values and changes if the axes are reordered, so it cannot
        order anybody. The composite under each name is the ordering; the shape says which
        dimensions produced it.
      </p>
    </div>
  )
}

function Cell({
  subject,
  reference,
  dim,
  onActive,
}: {
  subject: RadarSubject
  reference?: RadarReference
  dim: boolean
  onActive: (id: string | null) => void
}) {
  // Taken from the shared `sm` frame rather than restated, so a cell can never
  // end up on a different scale from the chart it is a small multiple of.
  const { geometry, width, height } = radarFrame('sm')
  const { missing } = radarShape(subject.values, geometry)

  return (
    <li
      // The whole cell is the target at this size — 14 charts × 4 vertices would be
      // 56 tab stops for data that is already printed as text underneath. Hover and
      // focus land on the same element and produce the same effect.
      tabIndex={0}
      aria-label={describeProfile(subject)}
      className="rounded-lg p-1 outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--color-ink)]"
      style={{ opacity: dim ? 0.4 : 1 }}
      onMouseEnter={() => onActive(subject.id)}
      onMouseLeave={() => onActive(null)}
      onFocus={() => onActive(subject.id)}
      onBlur={() => onActive(null)}
    >
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" aria-hidden="true">
        <RadarFrame size="sm" missing={missing} reference={reference} />
        <RadarShape subject={subject} size="sm" geometry={geometry} />
      </svg>
      <p className="mt-0.5 truncate text-[11px] font-medium" title={subject.name}>
        {subject.name}
      </p>
      {subject.meta ? (
        <p className="truncate text-[10px] text-[var(--color-muted)]" title={subject.meta}>
          {subject.meta}
        </p>
      ) : null}
      <p className="tnum text-[11px]">
        <span className="font-semibold">{subject.score === null ? '—' : subject.score.toFixed(1)}</span>
        <span className="text-[var(--color-muted)]"> composite</span>
      </p>
      {/* The four numbers as text, in the fixed axis order, initialled to match
          the chart above. The shape is never the only way to read a value. */}
      <p className="tnum text-[10px] text-[var(--color-muted)]">
        {RADAR_AXES.map((axis) => {
          const value = subject.values[axis.key]
          return `${axis.short} ${value === null ? '—' : value.toFixed(0)}`
        }).join(' · ')}
      </p>
    </li>
  )
}
