/**
 * How much of something we actually have, against the floor it has to clear.
 *
 * Three decisions, each against a more flattering alternative:
 *
 * 1. **The span is always the full 0-100.** A coverage figure is a share of a known
 *    whole, so 0 and 100 both mean something fixed and there is no honest reason to
 *    zoom. Fitting the axis to the data is what makes a chart lie — the same rule
 *    `chart-scale.ts` enforces with its 40-point floor on the score charts, except
 *    here the fixed domain is available, so it is used rather than approximated.
 * 2. **One series colour, and hollow for the thin case.** A bar that has not
 *    cleared its floor is drawn as an outline in the same hue, never in a second
 *    one: the reader is being told this share is not enough to report on, which is
 *    the same statement the hollow dots make on the scatter.
 * 3. **Unknown draws no bar at all.** A null coverage figure is not 0% and it is
 *    certainly not 100%. The track is drawn dashed and empty and the value reads
 *    "unknown", because the one thing this page may not do is round a gap in its
 *    own knowledge down to a comfortable number.
 */

import { pct } from '@/lib/format'
import { guardLevel, type Guard } from '@/lib/trust'

const TRACK_W = 208
const TRACK_H = 26
const BAR_H = 9
const INSET = 1

export interface CoverageMeterRow {
  label: string
  /** The share, 0-100, or null when it was never measured. */
  value: number | null
  /** The floor this share must clear for the metric it governs to be reported. */
  floor: number
  /** What the share is a share of, in words: "of the period has deploy history". */
  of: string
  /** What is lost when the floor is not cleared. */
  consequence: string
}

export function CoverageMeters({ rows }: { rows: CoverageMeterRow[] }) {
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.label} className="grid gap-x-4 gap-y-1 sm:grid-cols-[13rem_auto_1fr]">
          <span className="self-center text-xs font-medium">{row.label}</span>
          <span className="self-center">
            <Meter value={row.value} floor={row.floor} label={row.label} />
          </span>
          <span className="self-center text-[11px] leading-snug text-[var(--color-muted)]">
            {row.value === null ? (
              <>
                <strong className="text-amber-600 dark:text-amber-400">Unknown</strong> — nothing
                was measured, so this is not 0% and not 100%. {row.consequence}
              </>
            ) : row.value >= row.floor ? (
              <>
                {pct(row.value, 1)} {row.of} — clears the {row.floor}% floor.
              </>
            ) : (
              <>
                {pct(row.value, 1)} {row.of} — under the {row.floor}% floor, so{' '}
                {row.consequence.toLowerCase()}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Meter({
  value,
  floor,
  label,
}: {
  value: number | null
  floor: number
  label: string
}) {
  const at = (v: number) => INSET + (v / 100) * (TRACK_W - INSET * 2)
  const mid = TRACK_H / 2
  const level = guardLevel({ kind: 'coverage', pct: value, floor, of: '' })
  const y = mid - BAR_H / 2

  return (
    <span className="flex items-center gap-2">
      <svg
        width={TRACK_W}
        height={TRACK_H}
        viewBox={`0 0 ${TRACK_W} ${TRACK_H}`}
        className="shrink-0"
        role="img"
        aria-label={
          value === null
            ? `${label}: unknown, against a floor of ${floor}%`
            : `${label}: ${value.toFixed(1)} of 100, against a floor of ${floor}%`
        }
      >
        {/* The whole 0-100 run, always drawn, so the bar's length is readable
            against a fixed span rather than against the other rows. */}
        <rect
          x={at(0)}
          y={y}
          width={at(100) - at(0)}
          height={BAR_H}
          rx={BAR_H / 2}
          fill={value === null ? 'none' : 'var(--chart-grid)'}
          stroke={value === null ? 'var(--chart-grid)' : 'none'}
          strokeWidth={1}
          strokeDasharray={value === null ? '3 3' : undefined}
        />

        {value !== null && value > 0 ? (
          level === 'ok' ? (
            <rect
              x={at(0)}
              y={y}
              width={Math.max(BAR_H, at(value) - at(0))}
              height={BAR_H}
              rx={BAR_H / 2}
              fill="var(--chart-series)"
            />
          ) : (
            // Hollow, not a second hue: the share is real, it is just not enough.
            <rect
              x={at(0) + 1}
              y={y + 1}
              width={Math.max(BAR_H, at(value) - at(0)) - 2}
              height={BAR_H - 2}
              rx={(BAR_H - 2) / 2}
              fill="none"
              stroke="var(--chart-series)"
              strokeWidth={2}
            />
          )
        ) : null}

        {/* The floor, which is the only reference on this track. */}
        <line
          x1={at(floor)}
          x2={at(floor)}
          y1={mid - BAR_H}
          y2={mid + BAR_H}
          stroke="var(--chart-ref)"
          strokeWidth={1}
        />
        <text
          x={at(floor)}
          y={TRACK_H - 1}
          textAnchor="middle"
          className="tnum fill-[var(--color-muted)] text-[8px]"
        >
          {floor}
        </text>
      </svg>
      <span className="tnum w-12 shrink-0 text-[11px] font-medium">
        {value === null ? 'unknown' : pct(value, 0)}
      </span>
    </span>
  )
}

/**
 * A sample-floor guard as a sentence rather than a bar.
 *
 * Counts have no fixed whole to be a share of, so a meter would need an invented
 * ceiling and the bar's length would mean whatever that invention was. The count
 * and its floor are the entire fact, so they are stated.
 */
export function GuardSummary({ guard }: { guard: Guard }) {
  if (guard.kind === 'coverage') {
    return (
      <span className="tnum text-xs">
        {guard.pct === null ? 'unknown' : pct(guard.pct, 1)}{' '}
        <span className="text-[var(--color-muted)]">
          {guard.of} · floor {guard.floor}%
        </span>
      </span>
    )
  }
  return (
    <span className="tnum text-xs">
      n = {guard.n.toLocaleString('en-GB')}{' '}
      <span className="text-[var(--color-muted)]">
        {guard.unit} · floor {guard.floor}
      </span>
    </span>
  )
}
