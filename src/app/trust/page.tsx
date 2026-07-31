import { TrustReport } from '@/components/sections/trust-report'
import { cronStatus } from '@/lib/env'
import {
  getEngineerOutliers,
  getEngineersForAdmin,
  getOrgKpis,
  getSourceHealth,
  getSquadOutliers,
  getUnmatchedIdentities,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'
import { getWindowCoverage } from '@/lib/sync/coverage'
import { readCron } from '@/lib/trust'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Data trust — PMG Engineering Tracker' }

/**
 * How much should you trust today's numbers.
 *
 * All of the reasoning is in `TrustReport`; this is the fetch. The split is not
 * ceremony — the report takes every value as a prop, which is the only way it can be
 * rendered against real figures without a live request, and the RPCs here refuse to
 * run as `anon` under `DISABLE_AUTH`.
 */
export default async function TrustPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const { key, range } = resolvePeriod(period)

  const [kpis, sources, coverage, outliers, squads, identities, directory] = await Promise.all([
    getOrgKpis(range),
    getSourceHealth(),
    // How far back the collection actually reaches, per stream. Read for the selected
    // period, because that is the question: 90 days is fully collected here and 12
    // months is not, and a coverage figure that ignored the period could not say so.
    getWindowCoverage(range),
    getEngineerOutliers(range),
    getSquadOutliers(range),
    getUnmatchedIdentities(),
    // The `…ForAdmin` read, because the count of people held out of the metrics is
    // itself a trust fact and the ordinary read filters exactly those rows away.
    // Counted, never listed: this page says how many, the admin screen says who.
    getEngineersForAdmin(),
  ])

  return (
    <TrustReport
      periodLabel={PERIODS[key].label}
      kpis={kpis}
      sources={sources}
      coverage={coverage}
      // The one fact on this page read from configuration rather than from data, and
      // the only failure the data cannot show: a refused cron writes no row, so there
      // is no stale row to find. Read here because a server component can, and passed
      // in as a prop like everything else so the report stays renderable without a
      // request.
      cron={readCron(cronStatus())}
      outliers={outliers}
      squads={squads}
      identities={identities}
      people={{
        directory: directory.length,
        inMetrics: kpis.headcount,
        ignored: directory.filter((e) => e.is_ignored).length,
        former: directory.filter((e) => !e.is_ignored && !e.is_active).length,
        excluded: directory.filter(
          (e) => !e.is_ignored && e.is_active && !e.include_in_metrics,
        ).length,
      }}
    />
  )
}
