'use client'

import { useState } from 'react'

import { radarFrame, RadarFrame, RadarShape, RadarTicks } from '@/components/radar'
import { MetricNote, Pill } from '@/components/ui'
import {
  compareProfiles,
  compositeGap,
  describeProfile,
  gapTally,
  MATERIAL_GAP_POINTS,
  MAX_OVERLAID_SHAPES,
  overlayCheck,
  RADAR_MAX,
  RADAR_MIN,
  RADAR_REFERENCE,
  radarShape,
  REFERENCE_MEANING,
  type DimensionGap,
  type GapVerdict,
  type RadarAxisKey,
  type RadarKind,
  type RadarReference,
  type RadarSubject,
} from '@/lib/radar-geometry'

/**
 * Two subjects, compared dimension by dimension.
 *
 * This is the view that gets opened in the ten minutes before a calibration
 * conversation, which sets everything about how it is built. Its job is not to
 * produce a winner — it is to say, per dimension, whether there is anything there
 * to talk about. A compare view that turns a two-point difference into a win is
 * worse than no compare view, because it arrives with the authority of a chart.
 *
 * **The materiality rule.** A dimension is only labelled a real difference when
 * the two scores are at least `MATERIAL_GAP_POINTS` = 15 apart, and that number is
 * not new here. `score_vs_cohort` in `0021_outliers.sql` builds every sub-score so
 * one cohort interquartile range is 15 points; `0018_material_performance_bands.sql`
 * will not call a dimension `above` until an engineer reaches their cohort's third
 * quartile, nor `below` until the first — so one IQR is already the smallest
 * distance at which this app is willing to say two engineers are in different
 * places, and the Gap column on `/outliers` reads *even* for anything less. Two
 * suppressions come first, in 0018's order: a dimension either side has no data for
 * is *not readable*, and a subject whose confidence is not `high` makes every gap
 * *not readable* — "cannot see" is never collapsed into "nothing there". The rule
 * lives in `@/lib/radar-geometry` (`scoreGap`) and is tested.
 *
 * **Exactly two shapes.** Overlaid polygons occlude each other; from three onward a
 * reader cannot tell which outline owns which vertex, so the chart stops carrying
 * the values it appears to show. More than two renders an error rather than mush,
 * and points at the small multiples, which is the view that scales. The
 * cohort-median backdrop does not count: it has no vertices of its own.
 *
 * **The dot plot is the part that answers the question.** A radar shows two shapes
 * and lets the eye guess at the differences; the paired dot plot puts both values
 * on one shared 0-100 track per dimension, so the gap is a length rather than an
 * impression, and prints the verdict next to it. The track is the same fixed 0-100
 * scale as the radar above it — deliberately not `scoreDomain`, because the two
 * charts have to agree, and zooming the track to 40 points would make one
 * interquartile range look like a third of the distance available.
 */

export type HeadToHeadProps = {
  /**
   * Exactly two subjects. More renders an error state, fewer a prompt — see
   * `MAX_OVERLAID_SHAPES`.
   */
  subjects: RadarSubject[]
  /**
   * The shape both subjects are sat against — the median of their own seniority
   * level, usually, which is the single most useful radar in the set: one engineer
   * against the median profile of their own cohort answers "is this shape unusual
   * for someone at this level", which no ranking can.
   */
  reference?: RadarReference
  /**
   * What the two subjects are. Drives the copy, and drives what the chart says 50
   * means: a cohort median for engineers, halfway between the bad and good target
   * for squads, which are scored against absolutes rather than against each other.
   */
  kind?: RadarKind
  className?: string
}

export function HeadToHead({
  subjects,
  reference,
  kind = 'engineers',
  className = '',
}: HeadToHeadProps) {
  const [activeAxis, setActiveAxis] = useState<RadarAxisKey | null>(null)
  const check = overlayCheck(subjects.length)

  if (!check.ok) {
    return (
      <div
        className={`rounded-xl border p-5 ${
          check.reason === 'too-many'
            ? 'border-amber-500/50 bg-amber-50 dark:bg-amber-950/30'
            : 'border-[var(--color-line)] bg-[var(--color-surface)]'
        } ${className}`}
        role={check.reason === 'too-many' ? 'alert' : undefined}
      >
        <p className="text-sm font-semibold">
          {check.reason === 'too-many'
            ? `A radar carries ${MAX_OVERLAID_SHAPES} shapes, not ${subjects.length}`
            : 'Nothing to compare yet'}
        </p>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-muted)]">{check.message}</p>
        {check.reason === 'too-many' ? (
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Showing them anyway would be the dishonest option: the chart would look like it
            was carrying {subjects.length} profiles while being unreadable for all of them.
          </p>
        ) : null}
      </div>
    )
  }

  const [a, b] = subjects as [RadarSubject, RadarSubject]
  const gaps = compareProfiles(a, b)
  const composite = compositeGap(a, b)
  const tally = gapTally(gaps)
  const material = gaps.filter((g) => g.verdict === 'material')
  const aheadA = material.filter((g) => g.leader === 'a')
  const aheadB = material.filter((g) => g.leader === 'b')
  const unreadable = gaps.filter((g) => g.verdict === 'unreadable')
  const geometry = radarFrame('md').geometry
  const { width, height } = radarFrame('md')
  const missing = [
    ...new Set([
      ...radarShape(a.values, geometry).missing,
      ...radarShape(b.values, geometry).missing,
    ]),
  ]

  return (
    <div className={className}>
      {/* --- the headline, which is a count of real differences --------------- */}
      {/* The headline distinguishes three states and never collapses them. "Nothing
          is materially apart" claims we looked; when every gap is unreadable we did
          not, and saying otherwise would be the one lie this component exists to
          avoid. It showed up the first time this was rendered against a thin
          engineer: a 98-vs-0 flow gap was headlined "the same profile". */}
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
        <p className="text-sm font-semibold">
          {tally.unreadable === gaps.length
            ? 'Nothing here is readable'
            : tally.material === 0
              ? 'No dimension is materially apart'
              : tally.material === 1
                ? '1 of 4 dimensions is materially apart'
                : `${tally.material} of 4 dimensions are materially apart`}
        </p>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-muted)]">
          {tally.unreadable === gaps.length ? (
            <>
              These two cannot be compared on any dimension. {unreadable[0]?.reason ?? ''}. The
              numbers are all below and on the chart, but a gap measured against an
              indicative score is not a gap, so nothing here is a finding — however large it
              looks.
            </>
          ) : tally.material === 0 ? (
            <>
              On the {tally.same} dimension{tally.same === 1 ? '' : 's'} that can be read,
              these two {kind} have the same profile: each is inside one interquartile range
              of the other, which is the point below which this app refuses to call a
              difference real.
            </>
          ) : (
            <>
              {aheadA.length > 0 ? (
                <>
                  <strong>{a.name}</strong> is ahead on{' '}
                  {aheadA.map((g) => g.label.toLowerCase()).join(' and ')}.{' '}
                </>
              ) : null}
              {aheadB.length > 0 ? (
                <>
                  <strong>{b.name}</strong> is ahead on{' '}
                  {aheadB.map((g) => g.label.toLowerCase()).join(' and ')}.{' '}
                </>
              ) : null}
              {tally.same > 0 ? (
                <>
                  {tally.same === 1
                    ? 'The other readable dimension is inside one interquartile range and reads'
                    : 'The other readable dimensions are inside one interquartile range and read'}{' '}
                  as the same score.{' '}
                </>
              ) : null}
            </>
          )}
          {tally.unreadable > 0 && tally.unreadable < gaps.length ? (
            <>
              {unreadable.map((g) => g.label).join(' and ')}{' '}
              {unreadable.length === 1 ? 'is' : 'are'} not readable at all rather than equal —{' '}
              {unreadable[0]!.reason}.
            </>
          ) : null}
        </p>

        {/* The composite, under the same gate as the dimensions. */}
        <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--color-line)] pt-3">
          <span className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
            Composite
          </span>
          <span className="tnum text-sm">
            <SlotSwatch slot="a" /> {a.name}{' '}
            <strong>{a.score === null ? '—' : a.score.toFixed(1)}</strong>
          </span>
          <span className="tnum text-sm">
            <SlotSwatch slot="b" /> {b.name}{' '}
            <strong>{b.score === null ? '—' : b.score.toFixed(1)}</strong>
          </span>
          <VerdictPill verdict={composite.verdict} gap={composite.gap} />
          <span className="text-[11px] text-[var(--color-muted)]">{composite.reason}</span>
        </div>
      </div>

      {/* --- the two shapes --------------------------------------------------- */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label={`Two profiles overlaid. ${describeProfile(a)} ${describeProfile(b)}`}
          >
            <RadarFrame
              size="md"
              activeAxis={activeAxis}
              missing={missing}
              reference={reference}
            />
            {/* b under a: a is filled, so drawing it last would bury b's outline. */}
            <RadarShape subject={b} size="md" slot="b" geometry={geometry} activeAxis={activeAxis} />
            <RadarShape subject={a} size="md" slot="a" geometry={geometry} activeAxis={activeAxis} />
            <RadarTicks size="md" />
          </svg>

          {/* Two series need a legend, and the legend has to name the marks rather
              than only the colours — a reader in greyscale has the dash pattern and
              the vertex shape and nothing else. */}
          <ul className="mt-1 space-y-1 text-[11px] text-[var(--color-muted)]">
            <li className="flex items-start gap-1.5">
              <SlotKey slot="a" solid={a.solid} />
              <span>
                <span className="font-medium text-[var(--color-ink)]">{a.name}</span>
                {a.meta ? ` · ${a.meta}` : ''} — solid outline, round points
              </span>
            </li>
            <li className="flex items-start gap-1.5">
              <SlotKey slot="b" solid={b.solid} />
              <span>
                <span className="font-medium text-[var(--color-ink)]">{b.name}</span>
                {b.meta ? ` · ${b.meta}` : ''} — dashed outline, diamond points
              </span>
            </li>
            {reference ? (
              <li className="flex items-start gap-1.5">
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
              </li>
            ) : null}
            <li className="flex items-start gap-1.5">
              <svg width="12" height="12" aria-hidden="true" className="mt-0.5 shrink-0">
                <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--chart-ref)" />
              </svg>
              <span>
                inner ring is {RADAR_REFERENCE}, {REFERENCE_MEANING[kind]}
              </span>
            </li>
            {a.solid && b.solid ? null : (
              <li className="text-amber-600 dark:text-amber-400">
                Hollow points mark thin data:{' '}
                {[!a.solid ? (a.note ?? a.name) : null, !b.solid ? (b.note ?? b.name) : null]
                  .filter(Boolean)
                  .join('; ')}
              </li>
            )}
          </ul>
        </div>

        {/* --- the paired dot plot, which is where the answer actually is ------ */}
        <PairedDots
          a={a}
          b={b}
          gaps={gaps}
          kind={kind}
          activeAxis={activeAxis}
          onAxis={setActiveAxis}
        />
      </div>

      <MetricNote>
        A dimension is called a real gap only at {MATERIAL_GAP_POINTS}
        {' points or more. '}
        {kind === 'engineers' ? (
          <>
            That is one interquartile range of the cohort&apos;s own spread — the same gate the{' '}
            <em>gap</em> column on Outliers applies, and the reason two scores a point apart
            both read <em>even</em> there.
          </>
        ) : (
          <>
            Squads are scored against absolute targets rather than against each other, so 15
            points here is not an interquartile range of anything — it is the engineers&apos;
            gate applied unchanged, on purpose, because a compare view whose threshold moves
            with the kind of subject is worse than one conservative number. Outliers already
            says a two-point gap between squads is not a story.
          </>
        )}{' '}
        Below the gate the two {kind} are the same on that dimension, not narrowly separated.
        And the shapes are comparable by outline but never by size: the area of a radar polygon
        grows with the square of the values and changes if the axes are reordered, so it cannot
        order anybody — the composites above are the ordering.
      </MetricNote>
    </div>
  )
}

// --- the paired dot plot ----------------------------------------------------

/**
 * One shared 0-100 track per dimension, both values on it.
 *
 * **Laid out in HTML rather than drawn as one SVG.** A single SVG for the whole plot
 * scales its own type with the container: the same chart rendered 11px labels at
 * 22px in a wide column and at 8px on a phone, so it either shouted at the page
 * around it or became unreadable. Positioning the marks by percentage inside HTML
 * rows keeps every label at real page type size at any width, and the marks
 * themselves are fixed-size SVGs that never stretch.
 *
 * The track is a fixed 0-100 — not `scoreDomain` — so a length here means the same
 * thing as a radius on the radar above it, and so the {@link MATERIAL_GAP_POINTS}
 * bracket under the axis is a width a reader can carry from row to row. The
 * connector between a pair is solid when the gap clears the gate and dotted when it
 * does not, so the verdict is in the mark and not only in the words.
 */
function PairedDots({
  a,
  b,
  gaps,
  kind,
  activeAxis,
  onAxis,
}: {
  a: RadarSubject
  b: RadarSubject
  gaps: DimensionGap[]
  kind: RadarKind
  activeAxis: RadarAxisKey | null
  onAxis: (axis: RadarAxisKey | null) => void
}) {
  const pct = (v: number) => ((v - RADAR_MIN) / (RADAR_MAX - RADAR_MIN)) * 100
  // One column definition for the rows and for the axis beneath them, so the ticks
  // cannot drift out of line with the marks. The gutter is wide enough for a mark at
  // 0 or 100 to hang half outside the track without touching the labels either side.
  const COLS =
    'grid grid-cols-[5.5rem_minmax(0,1fr)_4.75rem] gap-x-3 sm:grid-cols-[7rem_minmax(0,1fr)_5.5rem]'

  return (
    // Capped so the verdict column stays beside the marks it belongs to rather than
    // being pushed to the far edge of a wide page.
    <div className="max-w-[46rem]">
      <ul className="list-none">
        {gaps.map((gap) => {
          const dim = activeAxis != null && activeAxis !== gap.axis
          const hasBoth = gap.a !== null && gap.b !== null
          const lo = hasBoth ? Math.min(gap.a!, gap.b!) : 0
          const hi = hasBoth ? Math.max(gap.a!, gap.b!) : 0
          return (
            <li
              key={gap.axis}
              // The row is the target: 40px tall, well over the 24px minimum, and
              // hover and keyboard focus land on the same element so the two cannot
              // disagree about what is highlighted.
              tabIndex={0}
              aria-label={`${gap.label}: ${a.name} ${
                gap.a === null ? 'no score' : gap.a.toFixed(1)
              }, ${b.name} ${gap.b === null ? 'no score' : gap.b.toFixed(1)}. ${gap.reason}.`}
              className={`${COLS} items-center rounded outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--color-ink)]`}
              style={{ opacity: dim ? 0.4 : 1 }}
              onMouseEnter={() => onAxis(gap.axis)}
              onMouseLeave={() => onAxis(null)}
              onFocus={() => onAxis(gap.axis)}
              onBlur={() => onAxis(null)}
            >
              <div className="py-1.5 text-right">
                <span className="block text-[11px] leading-tight">{gap.label}</span>
                <span className="tnum block text-[10px] leading-tight text-[var(--color-muted)]">
                  {gap.a === null ? '—' : gap.a.toFixed(1)} vs{' '}
                  {gap.b === null ? '—' : gap.b.toFixed(1)}
                </span>
              </div>

              <div className="relative h-10">
                {/* Grid, recessive. The 50 line is the reference and is not grid. */}
                {[0, 25, 50, 75, 100].map((t) => (
                  <span
                    key={t}
                    aria-hidden
                    className="absolute top-0 bottom-0 w-px"
                    style={{
                      left: `${pct(t)}%`,
                      backgroundColor:
                        t === RADAR_REFERENCE ? 'var(--chart-ref)' : 'var(--chart-grid)',
                    }}
                  />
                ))}
                <span
                  aria-hidden
                  className="absolute top-1/2 left-0 h-px w-full"
                  style={{ backgroundColor: 'var(--chart-grid)' }}
                />

                {hasBoth ? (
                  <span
                    aria-hidden
                    className="absolute top-1/2"
                    style={{
                      left: `${pct(lo)}%`,
                      width: `${pct(hi) - pct(lo)}%`,
                      height: gap.verdict === 'material' ? 2 : 0,
                      marginTop: gap.verdict === 'material' ? -1 : 0,
                      backgroundColor:
                        gap.verdict === 'material' ? 'var(--color-ink)' : 'transparent',
                      borderTop:
                        gap.verdict === 'material' ? undefined : '1px dotted var(--color-muted)',
                    }}
                  />
                ) : null}

                {/* b first, so a's round mark stays on top where the two coincide. */}
                {gap.b !== null ? <Mark at={pct(gap.b)} slot="b" solid={b.solid} /> : null}
                {gap.a !== null ? <Mark at={pct(gap.a)} slot="a" solid={a.solid} /> : null}
              </div>

              <div className="py-1.5">
                <span
                  className={`block text-[11px] leading-tight ${
                    gap.verdict === 'material'
                      ? 'font-medium text-[var(--color-ink)]'
                      : 'text-[var(--color-muted)]'
                  }`}
                >
                  {gap.verdict === 'material'
                    ? 'real gap'
                    : gap.verdict === 'same'
                      ? 'same'
                      : 'not readable'}
                </span>
                <span className="tnum block text-[10px] leading-tight text-[var(--color-muted)]">
                  {gap.gap === null ? 'no gap' : `${gap.gap.toFixed(1)} pts`}
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      {/* --- the axis, then the gate drawn to the same scale ------------------- */}
      <div className={COLS}>
        <div />
        <div>
          <div className="relative h-4">
            {[0, 25, 50, 75, 100].map((t) => (
              <span
                key={t}
                className="tnum absolute top-0 -translate-x-1/2 text-[10px] text-[var(--color-muted)]"
                style={{ left: `${pct(t)}%` }}
              >
                {t}
              </span>
            ))}
          </div>
          {/* 15 points as a width, so the gate is a distance and not a claim. */}
          <div className="relative mt-1 h-3">
            <span
              aria-hidden
              className="absolute top-1/2 left-0 border-t border-[var(--color-muted)]"
              style={{ width: `${pct(RADAR_MIN + MATERIAL_GAP_POINTS)}%` }}
            />
            {[RADAR_MIN, RADAR_MIN + MATERIAL_GAP_POINTS].map((v) => (
              <span
                key={v}
                aria-hidden
                className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-[var(--color-muted)]"
                style={{ left: `${pct(v)}%` }}
              />
            ))}
          </div>
          <p className="mt-0.5 text-[10px] leading-tight text-[var(--color-muted)]">
            {RADAR_REFERENCE} is {REFERENCE_MEANING[kind]}. The bracket is{' '}
            {MATERIAL_GAP_POINTS} points — the smallest gap this app will call real.
          </p>
        </div>
        <div />
      </div>

      {/* The reasons in full, because the verdict column is two words and the
          reasoning is the part that stops a gap being over-read. */}
      <dl className="mt-3 space-y-1">
        {gaps.map((gap) => {
          const dim = activeAxis != null && activeAxis !== gap.axis
          return (
            <div
              key={gap.axis}
              className="flex gap-2 text-[11px]"
              style={{ opacity: dim ? 0.45 : 1 }}
            >
              <dt className="w-[5.5rem] shrink-0 text-[var(--color-muted)] sm:w-[7rem]">
                {gap.label}
              </dt>
              <dd className="flex-1 text-[var(--color-muted)]">{gap.reason}</dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

/**
 * One value on a track: circle for slot a, diamond for slot b.
 *
 * A fixed-size SVG inside a percentage-positioned span, so the mark keeps its shape
 * and its size at every container width. The shape is half of what distinguishes the
 * two subjects in greyscale, and a stretched diamond would give that away.
 */
function Mark({ at, slot, solid }: { at: number; slot: 'a' | 'b'; solid: boolean }) {
  const colour = slot === 'a' ? 'var(--chart-series)' : 'var(--chart-series-2)'
  const fill = solid ? colour : 'var(--color-surface)'
  return (
    <span
      aria-hidden
      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${at}%` }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" className="block">
        {slot === 'a' ? (
          <>
            <circle cx="8" cy="8" r="6.5" fill="var(--color-surface)" />
            <circle cx="8" cy="8" r="4.5" fill={fill} stroke={colour} strokeWidth={solid ? 0 : 2} />
          </>
        ) : (
          <>
            <polygon points="8,0.5 15.5,8 8,15.5 0.5,8" fill="var(--color-surface)" />
            <polygon
              points="8,2.5 13.5,8 8,13.5 2.5,8"
              fill={fill}
              stroke={colour}
              strokeWidth={solid ? 0 : 2}
            />
          </>
        )}
      </svg>
    </span>
  )
}

function VerdictPill({ verdict, gap }: { verdict: GapVerdict; gap: number | null }) {
  if (verdict === 'material') {
    return (
      <span className="tnum">
        <Pill tone="good">{gap === null ? 'real' : `${gap.toFixed(1)} pts real`}</Pill>
      </span>
    )
  }
  if (verdict === 'same') {
    return (
      <span className="tnum">
        <Pill tone="neutral">same</Pill>
      </span>
    )
  }
  return <Pill tone="warn">not readable</Pill>
}

function SlotSwatch({ slot }: { slot: 'a' | 'b' }) {
  const colour = slot === 'a' ? 'var(--chart-series)' : 'var(--chart-series-2)'
  return (
    <svg width="10" height="10" aria-hidden="true" className="inline-block">
      {slot === 'a' ? (
        <circle cx="5" cy="5" r="4" fill={colour} />
      ) : (
        <polygon points="5,0 10,5 5,10 0,5" fill={colour} />
      )}
    </svg>
  )
}

/** The legend mark: outline pattern and vertex shape, which is what greyscale keeps. */
function SlotKey({ slot, solid }: { slot: 'a' | 'b'; solid: boolean }) {
  const colour = slot === 'a' ? 'var(--chart-series)' : 'var(--chart-series-2)'
  return (
    <svg width="26" height="12" aria-hidden="true" className="mt-0.5 shrink-0">
      <line
        x1="0"
        y1="6"
        x2="26"
        y2="6"
        stroke={colour}
        strokeWidth="2"
        strokeDasharray={slot === 'b' ? '5 3' : undefined}
      />
      {slot === 'a' ? (
        <circle
          cx="13"
          cy="6"
          r="3.4"
          fill={solid ? colour : 'var(--color-surface)'}
          stroke={colour}
          strokeWidth={solid ? 0 : 1.75}
        />
      ) : (
        <polygon
          points="13,1.5 17.5,6 13,10.5 8.5,6"
          fill={solid ? colour : 'var(--color-surface)'}
          stroke={colour}
          strokeWidth={solid ? 0 : 1.75}
        />
      )}
    </svg>
  )
}

// Types only. `MATERIAL_GAP_POINTS` and `MAX_OVERLAID_SHAPES` are deliberately not
// re-exported: this is a `'use client'` module, so a value taken from here would
// reach a server page as a client reference. Import them from
// `@/lib/radar-geometry`, which is where the rule is written and tested.
export type { DimensionGap, GapVerdict }
