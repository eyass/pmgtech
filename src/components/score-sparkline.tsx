import { comparablePair, segmentByDefinition, type ScoreSnapshot } from '@/lib/score-history'

/**
 * An engineer's composite score across captures, small enough to sit beside the
 * number it qualifies.
 *
 * A score on its own cannot say whether 48 is a recovery or a slide, and until now
 * this app could not either — `0025_score_snapshots.sql` names this sparkline as one
 * of the pieces lost with its worktree. This is it rebuilt.
 *
 * The one rule that shapes everything here: **a line only connects points computed
 * the same way.** `segmentByDefinition` splits the series wherever
 * `definition_version` changes, and each run is drawn as its own polyline with a
 * real gap between them. A dashed joint was the first attempt and it was wrong — a
 * dashed line still reads as one line, and the whole point is that there is no
 * continuity to read across a formula change. The gap is the message.
 *
 * Deliberately not drawn: axes, gridlines, or a y scale. At this size they would
 * cost more pixels than they inform, and the exact numbers are in the table this
 * sits next to. The `aria-label` and `<title>` carry the reading for anyone who
 * cannot see the shape, which is also what makes it legible to a screen reader
 * rather than announced as a decorative blob.
 */
export function ScoreSparkline({
  points,
  width = 108,
  height = 30,
  label,
}: {
  points: ScoreSnapshot[]
  width?: number
  height?: number
  /** Name used in the accessible description, e.g. the engineer's name. */
  label?: string
}) {
  const scored = points.filter((p) => p.score !== null)

  // One reading is not a trend. Saying so beats drawing a single dot that reads as
  // a flat line, which would claim stability nobody has measured.
  if (scored.length < 2) {
    return (
      <span className="text-xs text-[var(--color-muted)]">
        {scored.length === 0 ? 'no history' : '1 capture'}
      </span>
    )
  }

  const segments = segmentByDefinition(scored)
  const values = scored.map((p) => p.score as number)

  // Padded to the data rather than 0-100: at 30px tall, a fixed 0-100 axis flattens
  // every real movement into the same near-horizontal line.
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo < 4 ? 4 : hi - lo
  const mid = (hi + lo) / 2
  const top = mid + span / 2
  const bottom = mid - span / 2

  const pad = 2
  const innerW = width - pad * 2
  const innerH = height - pad * 2

  // x is indexed on position in the whole series, not per segment, so a gap left by
  // a version change occupies the horizontal space it actually spanned in time.
  const xFor = (index: number) => pad + (index / (scored.length - 1)) * innerW
  const yFor = (value: number) => pad + innerH - ((value - bottom) / (top - bottom)) * innerH

  // Each segment's offset into the whole series, derived rather than accumulated:
  // a running counter reassigned during render is exactly what
  // react-hooks/immutability forbids, and the segment count here is the number of
  // distinct scoring definitions, so the quadratic cost is nothing.
  const starts = segments.map((_, i) =>
    segments.slice(0, i).reduce((sum, s) => sum + s.points.length, 0),
  )

  const paths = segments.map((segment, segmentIndex) => {
    const start = starts[segmentIndex]
    return {
      version: segment.definitionVersion,
      d: segment.points
        .map(
          (p, i) =>
            `${i === 0 ? 'M' : 'L'} ${xFor(start + i).toFixed(1)} ${yFor(p.score as number).toFixed(1)}`,
        )
        .join(' '),
      single: segment.points.length === 1,
      cx: xFor(start),
      cy: yFor(segment.points[0].score as number),
    }
  })

  const first = values[0]
  const last = values[values.length - 1]
  const pair = comparablePair(scored)
  const trend = pair ? (last > first ? 'up' : last < first ? 'down' : 'flat') : 'unknown'

  const stroke =
    trend === 'up'
      ? 'var(--color-good)'
      : trend === 'down'
        ? 'var(--color-bad)'
        : 'var(--color-muted)'

  const who = label ? `${label}: ` : ''
  const description =
    segments.length > 1
      ? `${who}score across ${scored.length} captures, spanning ${segments.length} scoring formulas, which are not comparable with each other. Latest ${last.toFixed(1)}.`
      : `${who}score across ${scored.length} captures, ${first.toFixed(1)} to ${last.toFixed(1)}.`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={description}
      className="overflow-visible"
    >
      <title>{description}</title>

      {paths.map((path, i) =>
        path.single ? (
          // A lone point in its own version run still deserves to be visible — it is
          // the only reading taken under that formula.
          <circle key={i} cx={path.cx} cy={path.cy} r={1.6} fill={stroke} />
        ) : (
          <path
            key={i}
            d={path.d}
            fill="none"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}

      {/* Latest reading, so the eye lands on where things stand now. */}
      <circle cx={xFor(scored.length - 1)} cy={yFor(last)} r={2.2} fill={stroke} />
    </svg>
  )
}
