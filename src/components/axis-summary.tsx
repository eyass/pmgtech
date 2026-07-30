import type { ScatterPoint } from '@/components/scatter'

/**
 * The named ends of whatever two dimensions are on the chart.
 *
 * The scatter shows the shape; this says who. Ordered by the **mean of the two
 * shown sub-scores** — the composite narrowed to what is on screen — rather than
 * by the overall score, because otherwise the panel would answer a different
 * question than the chart beside it. Both components are printed next to the
 * mean so any placing here can be taken apart, same rule as the table.
 *
 * The cut at three is arbitrary, so the row that just missed is shown with the
 * distance it missed by. That number is the point: with this org's data the
 * middle of the field is bunched inside a couple of points, and a boundary drawn
 * through a bunch is a boundary, not a finding.
 */
export function AxisSummary({
  points,
  xLabel,
  yLabel,
}: {
  points: ScatterPoint[]
  xLabel: string
  yLabel: string
}) {
  if (points.length === 0) return null

  const ranked = points
    .map((p) => ({ ...p, mean: (p.x + p.y) / 2 }))
    .sort((a, b) => b.mean - a.mean)

  // Below eight there is no middle left to speak of, so ranking the ends would
  // just be the whole list split in two — show it as one list instead.
  if (ranked.length < 8) {
    return (
      <div className="text-[11px] text-[var(--color-muted)]">
        <p className="uppercase tracking-wide">
          Ranked · {xLabel} + {yLabel}
        </p>
        <ol className="mt-2 space-y-2">
          {ranked.map((p, i) => (
            <SummaryRow key={p.id} p={p} position={i + 1} xLabel={xLabel} yLabel={yLabel} />
          ))}
        </ol>
        <p className="mt-3 border-t border-[var(--color-line)] pt-2 leading-relaxed">
          Only {ranked.length} scored on both dimensions, so this is everyone rather than the ends.
        </p>
      </div>
    )
  }

  const top = ranked.slice(0, 3)
  const bottom = ranked.slice(-3).reverse()
  const missedTop = ranked[3]!
  const missedBottom = ranked[ranked.length - 4]!
  const anyIndicative = [...top, ...bottom].some((p) => !p.solid)

  return (
    <div className="text-[11px] text-[var(--color-muted)]">
      <p className="leading-relaxed">
        Ordered by the mean of <span className="text-[var(--color-ink)]">{xLabel}</span> and{' '}
        <span className="text-[var(--color-ink)]">{yLabel}</span>.
      </p>

      <p className="mt-3 uppercase tracking-wide">Top 3</p>
      <ol className="mt-2 space-y-2">
        {top.map((p, i) => (
          <SummaryRow key={p.id} p={p} position={i + 1} xLabel={xLabel} yLabel={yLabel} />
        ))}
      </ol>
      <Boundary
        label="4th"
        p={missedTop}
        behind={top[2]!.mean - missedTop.mean}
        compare="off 3rd"
      />

      <p className="mt-4 uppercase tracking-wide">Bottom 3</p>
      <ol className="mt-2 space-y-2">
        {bottom.map((p, i) => (
          <SummaryRow
            key={p.id}
            p={p}
            position={ranked.length - i}
            xLabel={xLabel}
            yLabel={yLabel}
          />
        ))}
      </ol>
      <Boundary
        label={`${ranked.length - 3}th`}
        p={missedBottom}
        behind={missedBottom.mean - bottom[bottom.length - 1]!.mean}
        compare={`clear of ${ranked.length - 2}th`}
      />

      <p className="mt-3 border-t border-[var(--color-line)] pt-2 leading-relaxed">
        A mean of two scores hides which half earned it, so each row names the half that
        sits below its cohort median — a high placing here is not automatically strength on
        both. Three is a round number rather than a threshold; check the gaps above and the{' '}
        <span className="text-[var(--color-ink)]">gap</span> column below before treating either end
        as a finding.
        {anyIndicative ? ' A hollow dot marks a placing built on thin data.' : ''}
      </p>
    </div>
  )
}

/**
 * Which half of the pair is carrying the mean.
 *
 * 50 is the cohort median, so "below median" here is a real statement rather than
 * a chosen threshold — and it is the one thing a mean of two scores destroys.
 */
function standing(p: ScatterPoint, xLabel: string, yLabel: string): string {
  const xLow = p.x < 50
  const yLow = p.y < 50
  if (!xLow && !yLow) return 'above median on both'
  if (xLow && yLow) return 'below median on both'
  return `below median on ${xLow ? xLabel : yLabel}`
}

function SummaryRow({
  p,
  position,
  xLabel,
  yLabel,
}: {
  p: ScatterPoint & { mean: number }
  position: number
  xLabel: string
  yLabel: string
}) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="tnum w-4 shrink-0 tabular-nums">{position}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-xs font-medium text-[var(--color-ink)]">
          {p.solid ? null : (
            <svg width="9" height="9" aria-label="thin data" className="shrink-0">
              <circle
                cx="4.5"
                cy="4.5"
                r="3"
                fill="none"
                stroke="var(--chart-series)"
                strokeWidth="1.75"
              />
            </svg>
          )}
          <span className="truncate">{p.name}</span>
        </span>
        <span className="tnum mt-0.5 block">
          {xLabel} {p.x.toFixed(1)} · {yLabel} {p.y.toFixed(1)}
        </span>
        {/* A mean of two numbers hides which half carried it, and with this data the
            top of the list is carried by throughput against below-median quality.
            Naming the weak half is what stops the mean reading as "good at both". */}
        <span className="mt-0.5 block text-[9px] uppercase tracking-wide">{standing(p, xLabel, yLabel)}</span>
      </span>
      <span className="tnum text-xs font-semibold text-[var(--color-ink)]">
        {p.mean.toFixed(1)}
      </span>
    </li>
  )
}

/** The row that just missed the cut, and by how little. */
function Boundary({
  label,
  p,
  behind,
  compare,
}: {
  label: string
  p: ScatterPoint & { mean: number }
  behind: number
  compare: string
}) {
  return (
    <p className="tnum mt-2 border-t border-dashed border-[var(--color-line)] pt-1.5">
      {label}: {p.name} at {p.mean.toFixed(1)} — {behind.toFixed(1)} {compare}
    </p>
  )
}
