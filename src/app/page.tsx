import Link from 'next/link'

import { SquadBarChart, TrendChart } from '@/components/charts'
import { AttributionBanner, SyncAlertBanner } from '@/components/coverage'
import { SetupNotice } from '@/components/setup-notice'
import { Bar, Card, Kpi, MetricNote, Pill, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { integrationStatus } from '@/lib/env'
import { compact, hours, nf, pct, relativeDate } from '@/lib/format'
import {
  getAttentionList,
  getDataFreshness,
  getDeliveryTrend,
  getOrgKpis,
  getSquadScorecards,
  getSyncAlerts,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'

export const dynamic = 'force-dynamic'

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const { key, range, bucket } = resolvePeriod(period)

  const [freshness, kpis, squads, trend, attention, syncAlerts] = await Promise.all([
    getDataFreshness(),
    getOrgKpis(range),
    getSquadScorecards(range),
    getDeliveryTrend(range, bucket),
    getAttentionList(undefined, 8),
    getSyncAlerts(),
  ])

  const squadKeys = squads.map((s) => s.squad_key)

  const deployWithheld =
    kpis.deploy_coverage_pct !== null && kpis.deploy_coverage_pct < 50
      ? `history covers ${pct(kpis.deploy_coverage_pct, 0)} of this period`
      : undefined

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Engineering overview</h1>
        <p className="text-sm text-[var(--color-muted)]">
          {PERIODS[key].label} · {kpis.headcount} engineers across {squads.length} squads
        </p>
      </div>

      {!freshness.hasAnyData ? (
        <SetupNotice integrations={integrationStatus()} freshness={freshness} />
      ) : (
        <SyncAlertBanner alerts={syncAlerts} />
      )}

      {/* --- headline KPIs ---------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Delivery health"
          hint="The four DORA metrics plus review throughput, for the whole engineering org."
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Deploy frequency"
            value={`${nf(kpis.deploys_per_week, 1)}/wk`}
            hint="Successful production deployments per week"
            direction="higher-better"
            raw={kpis.deploys_per_week}
            thresholds={{ good: 7, bad: 1 }}
            sample={kpis.deploy_sample}
            sampleUnit="finished deploys"
            withheld={deployWithheld}
          />
          <Kpi
            label="Lead time for change"
            value={hours(kpis.median_cycle_hours)}
            hint="Median first commit to merge"
            direction="lower-better"
            raw={kpis.median_cycle_hours}
            thresholds={{ good: 24, bad: 120 }}
            sample={kpis.cycle_sample}
            sampleUnit="merged MRs"
          />
          <Kpi
            label="Change failure rate"
            value={pct(kpis.change_failure_pct, 1)}
            hint="Failed production deploys / all finished"
            direction="lower-better"
            raw={kpis.change_failure_pct}
            thresholds={{ good: 15, bad: 30 }}
            sample={kpis.deploy_sample}
            sampleUnit="finished deploys"
            withheld={deployWithheld}
          />
          <Kpi
            label="Time to restore"
            value={hours(kpis.mttr_hours)}
            hint="Median failed deploy to next success"
            direction="lower-better"
            raw={kpis.mttr_hours}
            thresholds={{ good: 4, bad: 24 }}
            sample={kpis.mttr_sample}
            sampleUnit="recovered failures"
            withheld={deployWithheld}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Merged MRs"
            value={nf(kpis.merged_mrs)}
            hint={`${nf(kpis.mrs_per_engineer_week, 2)} per engineer per week`}
          />
          <Kpi
            label="Review wait"
            value={hours(kpis.median_review_wait_hours)}
            hint="Median open to first review"
            direction="lower-better"
            raw={kpis.median_review_wait_hours}
            thresholds={{ good: 4, bad: 24 }}
            sample={kpis.review_wait_sample}
            sampleUnit="merged MRs"
          />
          <Kpi
            label="Review coverage"
            value={pct(kpis.review_coverage_pct, 1)}
            hint="Merged MRs with at least one reviewer"
            direction="higher-better"
            raw={kpis.review_coverage_pct}
            thresholds={{ good: 90, bad: 60 }}
            sample={kpis.review_coverage_sample}
            sampleUnit="merged MRs"
          />
          <Kpi
            label="Issues resolved"
            value={nf(kpis.issues_resolved)}
            hint={`${pct(kpis.bug_ratio_pct)} bugs · median ${hours(kpis.median_issue_cycle_hours)} to close`}
            sample={kpis.issue_cycle_sample}
            sampleUnit="issues with timings"
          />
        </div>

        <MetricNote>
          Lead time is measured from the first commit on a branch to the merge, which is the part of
          the pipeline the team controls. Time to restore counts only failures that were actually
          followed by a successful deploy, so an unresolved incident does not silently inflate the
          median. Each card carries the number of observations behind it; medians built on fewer
          than twenty are withheld rather than shown, because at that size the metric moves with a
          single outlier.
        </MetricNote>
      </section>

      {/* --- squad comparison ------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Squads"
          hint="Work is attributed to the squad of the person who did it. The repository fallback does nothing here — this org has one monorepo that several squads share — so an unassigned engineer's work reaches no squad at all."
          action={
            <Link href="/squads" className="text-sm text-[var(--color-muted)] hover:underline">
              Compare in detail →
            </Link>
          }
        />

        <AttributionBanner kpis={kpis} />

        <Table
          empty="No squad activity in this period."
          head={
            <>
              <Th>Squad</Th>
              <Th align="right">People</Th>
              <Th align="right" title="Merged merge requests in the selected period">
                Merged
              </Th>
              <Th align="right" title="Merged MRs per engineer per week">
                Per eng/wk
              </Th>
              <Th align="right" title="Median first commit to merge">
                Lead time
              </Th>
              <Th align="right" title="Median time from MR open to first review">
                Review wait
              </Th>
              <Th align="right" title="Successful production deployments per week">
                Deploys/wk
              </Th>
              <Th align="right">Issues</Th>
            </>
          }
        >
          {squads.map((squad) => {
            const maxMerged = Math.max(...squads.map((s) => s.merged_mrs), 1)
            return (
              <tr key={squad.squad_id}>
                <Td>
                  <SquadBadge
                    squadKey={squad.squad_key}
                    name={squad.squad_name}
                    href={`/squads/${squad.squad_key}?period=${key}`}
                  />
                </Td>
                <Td align="right" numeric>
                  {squad.headcount === 0 ? (
                    <Pill tone="warn">none mapped</Pill>
                  ) : (
                    nf(squad.headcount)
                  )}
                </Td>
                <Td align="right" numeric>
                  <div className="flex flex-col items-end gap-1">
                    <span>{nf(squad.merged_mrs)}</span>
                    <div className="w-16">
                      <Bar value={squad.merged_mrs} max={maxMerged} colour={squad.colour} />
                    </div>
                  </div>
                </Td>
                <Td align="right" numeric>
                  {nf(squad.mrs_per_engineer_week, 2)}
                </Td>
                <Td align="right" numeric>
                  {hours(squad.median_cycle_hours)}
                </Td>
                <Td align="right" numeric>
                  {hours(squad.median_review_wait_hours)}
                </Td>
                <Td align="right" numeric>
                  {nf(squad.deploys_per_week, 1)}
                </Td>
                <Td align="right" numeric>
                  {nf(squad.issues_resolved)}
                </Td>
              </tr>
            )
          })}
        </Table>
      </section>

      {/* --- trends ----------------------------------------------------------- */}

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionHeading title="Merged merge requests" hint={`By ${bucket}, per squad`} />
          <TrendChart points={trend} metric="merged_mrs" bucket={bucket} squadKeys={squadKeys} stacked />
        </Card>
        <Card>
          <SectionHeading title="Lead time trend" hint="Median hours, first commit to merge" />
          <TrendChart
            points={trend}
            metric="median_cycle_hours"
            bucket={bucket}
            squadKeys={squadKeys}
          />
        </Card>
        <Card>
          <SectionHeading title="Issues resolved" hint={`By ${bucket}, per squad`} />
          <TrendChart
            points={trend}
            metric="issues_resolved"
            bucket={bucket}
            squadKeys={squadKeys}
            stacked
          />
        </Card>
        <Card>
          <SectionHeading title="Code churn" hint="Lines added plus removed, by squad" />
          <SquadBarChart squads={squads} metric="code_churn" />
          <MetricNote>
            Churn is context, not a target. It is here to explain a cycle-time change — a squad
            shipping large refactors will look slower per MR — not to be maximised.
          </MetricNote>
        </Card>
      </section>

      {/* --- attention list --------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Needs attention"
          hint="Open merge requests that are stale, unreviewed or unusually large."
          action={
            <Link href="/delivery" className="text-sm text-[var(--color-muted)] hover:underline">
              Full list →
            </Link>
          }
        />
        <Table
          empty="Nothing stuck — every open MR has been reviewed recently."
          head={
            <>
              <Th>Merge request</Th>
              <Th>Squad</Th>
              <Th>Author</Th>
              <Th align="right">Age</Th>
              <Th align="right">Size</Th>
              <Th>Why</Th>
            </>
          }
        >
          {attention.map((row) => (
            <tr key={row.merge_request_id}>
              <Td>
                <a
                  href={row.web_url ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {row.title ?? 'Untitled'}
                </a>
                <div className="text-xs text-[var(--color-muted)]">{row.project_name}</div>
              </Td>
              <Td>
                <SquadBadge squadKey={row.squad_key} name={row.squad_key ?? 'Unassigned'} />
              </Td>
              <Td>{row.author_name}</Td>
              <Td align="right" numeric>
                {hours(row.age_hours)}
              </Td>
              <Td align="right" numeric>
                {compact(row.churn)}
              </Td>
              <Td>
                <Pill tone={row.distinct_reviewers === 0 ? 'bad' : 'warn'}>{row.reason}</Pill>
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      <p className="text-xs text-[var(--color-muted)]">
        Last sync: {freshness.lastRun ? `${freshness.lastRun.source} · ${freshness.lastRun.status} · ${relativeDate(freshness.lastRun.finished_at)}` : 'never'}
        {kpis.unmapped_identities > 0 ? (
          <>
            {' · '}
            <Link href="/admin" className="underline">
              {kpis.unmapped_identities} unmapped {kpis.unmapped_identities === 1 ? 'identity' : 'identities'}
            </Link>
          </>
        ) : null}
      </p>
    </div>
  )
}
