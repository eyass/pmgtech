import { MEDIAN } from '@/lib/chart-scale'

/**
 * Each squad's four dimension scores, as small multiples rather than one chart.
 *
 * The reason for the shape is a colour budget. Four dimensions on one set of axes
 * needs four categorical colours, and the palette gates for this app's two
 * surfaces only clear three slots — a fourth would be a hue nobody can separate
 * from its neighbour under colour-vision deficiency. Splitting into one track per
 * dimension needs no categorical colour at all, and position carries the value
 * exactly, which a heat cell never does.
 *
 * Unlike the engineer charts, **these are absolute, not relative.** Squads are
 * scored against the delivery targets on `/performance`, so 0 is the bad
 * threshold, 100 is the good one, and 50 is genuinely halfway between the two
 * rather than the median of the other squads. A strong org does not manufacture a
 * loser here, so the domain is the fixed full 0-100 — the one chart on this page
 * that must not rescale to its data, because the thresholds are the point.
 */

export type SquadProfileRow = {
  key: string
  name: string
  score: number | null
  dimensions: { throughput: number | null; flow: number | null; quality: number | null; collaboration: number | null }
}

const DIMENSION_COLUMNS = [
  { key: 'throughput', label: 'Throughput' },
  { key: 'flow', label: 'Flow' },
  { key: 'quality', label: 'Quality' },
  { key: 'collaboration', label: 'Collaboration' },
] as const

const TRACK_W = 104
const TRACK_H = 18
const DOT_R = 5.5

export function SquadProfile({ rows }: { rows: SquadProfileRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--color-muted)]">
        No squad is scored in this period.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[38rem] border-collapse">
        <thead>
          <tr>
            <th className="pb-2 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
              Squad
            </th>
            {DIMENSION_COLUMNS.map((d) => (
              <th
                key={d.key}
                className="pb-2 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]"
              >
                {d.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-[var(--color-line)]">
              <td className="py-2 pr-4 align-middle">
                <span className="block text-xs font-medium">{row.name}</span>
                <span className="tnum block text-[10px] text-[var(--color-muted)]">
                  {row.score === null ? 'not scored' : `${row.score.toFixed(1)} overall`}
                </span>
              </td>
              {DIMENSION_COLUMNS.map((d) => (
                <td key={d.key} className="py-2 pr-3 align-middle">
                  <Track value={row.dimensions[d.key]} label={`${row.name} ${d.label}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * One dimension for one squad: the full 0-100 run, a tick at the halfway point,
 * and the value as both a position and a number.
 */
function Track({ value, label }: { value: number | null; label: string }) {
  if (value === null) {
    return (
      <span className="text-[10px] text-[var(--color-muted)]" aria-label={`${label}: no data`}>
        no data
      </span>
    )
  }
  // Inset by the mark's radius at both ends: a squad on 100 sits exactly on the
  // right edge, and without this its dot is drawn as a half-moon clipped by the
  // viewBox — which is most of them, since every squad clears most targets.
  const at = (v: number) => DOT_R + (v / 100) * (TRACK_W - DOT_R * 2)
  const x = at(value)
  return (
    <span className="flex items-center gap-2">
      <svg
        width={TRACK_W}
        height={TRACK_H}
        viewBox={`0 0 ${TRACK_W} ${TRACK_H}`}
        className="shrink-0"
        role="img"
        aria-label={`${label}: ${value.toFixed(1)} of 100`}
      >
        <line
          x1={at(0)}
          x2={at(100)}
          y1={TRACK_H / 2}
          y2={TRACK_H / 2}
          stroke="var(--chart-grid)"
          strokeWidth={2}
          strokeLinecap="round"
        />
        {/* Halfway between the bad and good thresholds — a real midpoint here. */}
        <line
          x1={at(MEDIAN)}
          x2={at(MEDIAN)}
          y1={TRACK_H / 2 - 4}
          y2={TRACK_H / 2 + 4}
          stroke="var(--chart-ref)"
          strokeWidth={1}
        />
        <circle cx={x} cy={TRACK_H / 2} r={DOT_R} fill="var(--color-surface)" />
        <circle cx={x} cy={TRACK_H / 2} r={DOT_R - 1.5} fill="var(--chart-series)" />
      </svg>
      <span className="tnum w-8 shrink-0 text-[11px]">{value.toFixed(0)}</span>
    </span>
  )
}
