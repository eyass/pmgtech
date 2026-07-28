import { SquadBarChart, TrendChart } from '@/components/charts'
import {
  Card,
  Kpi,
  MetricNote,
  Pill,
  SectionHeading,
  SquadBadge,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { compact, hours, nf, pct } from '@/lib/format'
import {
  getAttentionList,
  getDeliveryTrend,
  getOrgKpis,
  getSquadScorecards,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'

export const dynamic = 'force-dynamic'

/**
 * Delivery/DORA page. Where the overview gives one number per metric, this page
 * shows the distribution behind it and states each definition, because DORA
 * numbers get disputed far more often than they get acted on.
 */
export default async function DeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const { key, range, bucket } = resolvePeriod(period)

  const [kpis, squads, trend, attention] = await Promise.all([
    getOrgKpis(range),
    getSquadScorecards(range),
    getDeliveryTrend(range, bucket),
    getAttentionList(undefined, 40),
  ])

  const squadKeys = squads.map((s) => s.squad_key)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Delivery and DORA</h1>
        <p className="text-sm text-[var(--color-muted)]">{PERIODS[key].label}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Deploy frequency"
          value={`${nf(kpis.deploys_per_week, 1)}/wk`}
          hint={`${nf(kpis.prod_deploys)} successful production deploys`}
          direction="higher-better"
          raw={kpis.deploys_per_week}
          thresholds={{ good: 7, bad: 1 }}
        />
        <Kpi
          label="Lead time for change"
          value={hours(kpis.median_cycle_hours)}
          hint="Median first commit to merge"
          direction="lower-better"
          raw={kpis.median_cycle_hours}
          thresholds={{ good: 24, bad: 120 }}
        />
        <Kpi
          label="Change failure rate"
          value={pct(kpis.change_failure_pct, 1)}
          hint="Failed production deploys / all finished"
          direction="lower-better"
          raw={kpis.change_failure_pct}
          thresholds={{ good: 15, bad: 30 }}
        />
        <Kpi
          label="Time to restore"
          value={hours(kpis.mttr_hours)}
          hint="Median failed deploy to next success"
          direction="lower-better"
          raw={kpis.mttr_hours}
          thresholds={{ good: 4, bad: 24 }}
        />
      </div>

      <Card>
        <SectionHeading title="How these are calculated" />
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Definition term="Deploy frequency">
            Successful GitLab deployments to a production environment, divided by the number of
            weeks in the period. Which environments count as production is configurable — by default
            any environment whose name contains <code>production</code>, <code>prod</code> or{' '}
            <code>live</code>.
          </Definition>
          <Definition term="Lead time for change">
            Median hours from the first commit on a branch to the merge of its merge request. This
            deliberately excludes the deploy step, so it measures what the team controls rather than
            release-train timing.
          </Definition>
          <Definition term="Change failure rate">
            Failed production deployments as a share of all production deployments that finished.
            Deployments still running are excluded rather than assumed successful.
          </Definition>
          <Definition term="Time to restore">
            Median hours from a failed production deployment to the next successful one on the same
            project and environment. Failures never followed by a success are excluded, so an open
            incident cannot skew the median in either direction.
          </Definition>
        </dl>
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionHeading title="Deploy frequency trend" hint={`Production deploys by ${bucket}`} />
          <TrendChart points={trend} metric="prod_deploys" bucket={bucket} squadKeys={squadKeys} stacked />
        </Card>
        <Card>
          <SectionHeading title="Lead time trend" hint="Median hours by squad" />
          <TrendChart points={trend} metric="median_cycle_hours" bucket={bucket} squadKeys={squadKeys} />
        </Card>
        <Card>
          <SectionHeading title="Change failure rate by squad" hint="Lower is better" />
          <SquadBarChart squads={squads} metric="change_failure_pct" />
        </Card>
        <Card>
          <SectionHeading title="Commits" hint={`By ${bucket}, excluding merge commits`} />
          <TrendChart points={trend} metric="commits" bucket={bucket} squadKeys={squadKeys} stacked />
        </Card>
      </section>

      <section>
        <SectionHeading
          title="Review pipeline health"
          hint="Where merge requests actually lose time."
        />
        <Table
          empty="No merge request activity in this period."
          head={
            <>
              <Th>Squad</Th>
              <Th align="right">Merged</Th>
              <Th align="right" title="Median open to first review">
                Wait for review
              </Th>
              <Th align="right" title="Median first commit to merge">
                Total lead time
              </Th>
              <Th align="right">p75 lead time</Th>
              <Th align="right">Coverage</Th>
              <Th align="right">Median MR size</Th>
              <Th align="right">Large MRs</Th>
              <Th align="right">Open now</Th>
            </>
          }
        >
          {squads.map((squad) => (
            <tr key={squad.squad_id}>
              <Td>
                <SquadBadge
                  squadKey={squad.squad_key}
                  name={squad.squad_name}
                  href={`/squads/${squad.squad_key}?period=${key}`}
                />
              </Td>
              <Td align="right" numeric>{nf(squad.merged_mrs)}</Td>
              <Td align="right" numeric>{hours(squad.median_review_wait_hours)}</Td>
              <Td align="right" numeric>{hours(squad.median_cycle_hours)}</Td>
              <Td align="right" numeric>{hours(squad.p75_cycle_hours)}</Td>
              <Td align="right" numeric>{pct(squad.review_coverage_pct)}</Td>
              <Td align="right" numeric>{compact(squad.median_mr_churn)}</Td>
              <Td align="right" numeric>{pct(squad.large_mr_pct)}</Td>
              <Td align="right" numeric>{nf(squad.open_mrs)}</Td>
            </tr>
          ))}
        </Table>
        <MetricNote>
          Large merge requests are those changing more than 400 lines. They correlate strongly with
          slow reviews, so a high share here usually explains a poor review-wait number better than
          reviewer availability does.
        </MetricNote>
      </section>

      <section>
        <SectionHeading
          title="Open merge requests needing attention"
          hint="Unreviewed after a day, open longer than a week, or over 800 lines changed."
        />
        <Table
          empty="Nothing stuck across any squad."
          head={
            <>
              <Th>Merge request</Th>
              <Th>Squad</Th>
              <Th>Author</Th>
              <Th align="right">Age</Th>
              <Th align="right">Size</Th>
              <Th align="right">Reviewers</Th>
              <Th align="right">Comments</Th>
              <Th>Why</Th>
            </>
          }
        >
          {attention.map((row) => (
            <tr key={row.merge_request_id}>
              <Td>
                <a href={row.web_url ?? '#'} target="_blank" rel="noreferrer" className="hover:underline">
                  {row.title ?? 'Untitled'}
                </a>
                <div className="text-xs text-[var(--color-muted)]">{row.project_name}</div>
              </Td>
              <Td>
                <SquadBadge squadKey={row.squad_key} name={row.squad_key ?? 'Unassigned'} />
              </Td>
              <Td>{row.author_name}</Td>
              <Td align="right" numeric>{hours(row.age_hours)}</Td>
              <Td align="right" numeric>{compact(row.churn)}</Td>
              <Td align="right" numeric>{nf(row.distinct_reviewers)}</Td>
              <Td align="right" numeric>{nf(row.notes_count)}</Td>
              <Td>
                <Pill tone={row.distinct_reviewers === 0 ? 'bad' : 'warn'}>{row.reason}</Pill>
              </Td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  )
}

function Definition({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{term}</dt>
      <dd className="mt-0.5 text-[var(--color-muted)]">{children}</dd>
    </div>
  )
}
