import Link from 'next/link'

import { TrendChart } from '@/components/charts'
import { Card, Kpi, MetricNote, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { compact, hours, nf, pct } from '@/lib/format'
import {
  getDeliveryTrend,
  getReviewNetwork,
  getSquadScorecards,
  getWorkTypeMix,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'

export const dynamic = 'force-dynamic'

export default async function SquadsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const { key, range, bucket } = resolvePeriod(period)

  const [squads, trend, mix, network] = await Promise.all([
    getSquadScorecards(range),
    getDeliveryTrend(range, bucket),
    getWorkTypeMix(range),
    getReviewNetwork(range),
  ])

  const squadKeys = squads.map((s) => s.squad_key)
  const crossSquadReviews = network.filter((n) => n.reviewer_squad_id !== n.author_squad_id)
  const totalReviews = network.reduce((sum, n) => sum + n.reviews, 0)
  const crossSquadShare =
    totalReviews > 0
      ? (crossSquadReviews.reduce((sum, n) => sum + n.reviews, 0) / totalReviews) * 100
      : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Squad comparison</h1>
        <p className="text-sm text-[var(--color-muted)]">{PERIODS[key].label}</p>
      </div>

      {/* Per-squad cards give each team its own headline before the comparison
          table, so a squad lead can find their own numbers immediately. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {squads.map((squad) => (
          <Card key={squad.squad_id}>
            <div className="flex items-start justify-between">
              <div>
                <SquadBadge squadKey={squad.squad_key} name={squad.squad_name} />
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {nf(squad.headcount)} engineers · {nf(squad.active_contributors)} active this
                  period
                </p>
              </div>
              <Link
                href={`/squads/${squad.squad_key}?period=${key}`}
                className="text-sm text-[var(--color-muted)] hover:underline"
              >
                Detail →
              </Link>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="Merged" value={nf(squad.merged_mrs)} />
              <MiniStat label="Lead time" value={hours(squad.median_cycle_hours)} />
              <MiniStat label="Review wait" value={hours(squad.median_review_wait_hours)} />
              <MiniStat label="Deploys/wk" value={nf(squad.deploys_per_week, 1)} />
              <MiniStat label="Issues" value={nf(squad.issues_resolved)} />
              <MiniStat label="Points" value={nf(squad.story_points)} />
              <MiniStat label="Bugs" value={pct(squad.bug_ratio_pct)} />
              <MiniStat label="Churn" value={compact(squad.code_churn)} />
            </div>
          </Card>
        ))}
      </div>

      {/* --- full comparison -------------------------------------------------- */}

      <section>
        <SectionHeading
          title="All metrics side by side"
          hint="Rates are normalised per engineer per week so squads of different sizes can be compared."
        />
        <Table
          empty="No squad data in this period."
          head={
            <>
              <Th>Squad</Th>
              <Th align="right">People</Th>
              <Th align="right">Merged</Th>
              <Th align="right">Per eng/wk</Th>
              <Th align="right" title="Median first commit to merge">
                Lead time
              </Th>
              <Th align="right" title="75th percentile lead time — the tail your worst weeks feel">
                p75
              </Th>
              <Th align="right">Review wait</Th>
              <Th align="right" title="Share of merged MRs with at least one reviewer">
                Coverage
              </Th>
              <Th align="right" title="Median lines changed per merge request">
                MR size
              </Th>
              <Th align="right" title="Share of merged MRs over 400 lines changed">
                Large MRs
              </Th>
              <Th align="right">Reviews</Th>
              <Th align="right">Deploys/wk</Th>
              <Th align="right" title="Failed production deploys as a share of finished ones">
                CFR
              </Th>
              <Th align="right" title="Median time from a failed deploy to the next success">
                MTTR
              </Th>
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
              <Td align="right" numeric>{nf(squad.headcount)}</Td>
              <Td align="right" numeric>{nf(squad.merged_mrs)}</Td>
              <Td align="right" numeric>{nf(squad.mrs_per_engineer_week, 2)}</Td>
              <Td align="right" numeric>{hours(squad.median_cycle_hours)}</Td>
              <Td align="right" numeric>{hours(squad.p75_cycle_hours)}</Td>
              <Td align="right" numeric>{hours(squad.median_review_wait_hours)}</Td>
              <Td align="right" numeric>{pct(squad.review_coverage_pct)}</Td>
              <Td align="right" numeric>{compact(squad.median_mr_churn)}</Td>
              <Td align="right" numeric>{pct(squad.large_mr_pct)}</Td>
              <Td align="right" numeric>{nf(squad.reviews_given)}</Td>
              <Td align="right" numeric>{nf(squad.deploys_per_week, 1)}</Td>
              <Td align="right" numeric>{pct(squad.change_failure_pct, 1)}</Td>
              <Td align="right" numeric>{hours(squad.mttr_hours)}</Td>
            </tr>
          ))}
        </Table>
      </section>

      {/* --- trends and mix --------------------------------------------------- */}

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionHeading title="Throughput" hint={`Merged merge requests by ${bucket}`} />
          <TrendChart points={trend} metric="merged_mrs" bucket={bucket} squadKeys={squadKeys} stacked />
        </Card>
        <Card>
          <SectionHeading title="Production deploys" hint={`By ${bucket}`} />
          <TrendChart points={trend} metric="prod_deploys" bucket={bucket} squadKeys={squadKeys} stacked />
        </Card>
      </section>

      <section>
        <SectionHeading
          title="What the work was"
          hint="Resolved Jira issues by type. A squad spending most of its capacity on bugs is not a throughput problem."
        />
        <div className="grid gap-4 lg:grid-cols-2">
          {squads.map((squad) => {
            const rows = mix.filter((m) => m.squad_id === squad.squad_id)
            if (rows.length === 0) return null
            return (
              <Card key={squad.squad_id}>
                <SquadBadge squadKey={squad.squad_key} name={squad.squad_name} />
                <div className="mt-3 space-y-2">
                  {rows.slice(0, 6).map((row) => (
                    <div key={row.issue_type} className="flex items-center gap-3 text-sm">
                      <span className="w-32 shrink-0 truncate">{row.issue_type}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-line)]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${row.share_pct ?? 0}%`,
                            backgroundColor: squad.colour,
                          }}
                        />
                      </div>
                      <span className="tnum w-20 shrink-0 text-right text-xs text-[var(--color-muted)]">
                        {nf(row.issues)} · {pct(row.share_pct)}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            )
          })}
        </div>
      </section>

      {/* --- review network --------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Review flow between squads"
          hint="Who reviews whose code. Low cross-squad review usually means knowledge is siloed."
        />
        <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
          <Kpi
            label="Cross-squad reviews"
            value={pct(crossSquadShare, 1)}
            hint="Share of all reviews given outside the author's squad"
            direction="higher-better"
            raw={crossSquadShare}
            thresholds={{ good: 20, bad: 5 }}
          />
          <Table
            empty="No review activity recorded in this period."
            head={
              <>
                <Th>Reviewer squad</Th>
                <Th>Author squad</Th>
                <Th align="right">Reviews</Th>
                <Th align="right">Share</Th>
              </>
            }
          >
            {network.slice(0, 12).map((row) => (
              <tr key={`${row.reviewer_squad_id}-${row.author_squad_id}`}>
                <Td>{row.reviewer_squad}</Td>
                <Td>
                  {row.author_squad}
                  {row.reviewer_squad_id === row.author_squad_id ? (
                    <span className="ml-2 text-xs text-[var(--color-muted)]">(internal)</span>
                  ) : null}
                </Td>
                <Td align="right" numeric>{nf(row.reviews)}</Td>
                <Td align="right" numeric>
                  {pct(totalReviews > 0 ? (row.reviews / totalReviews) * 100 : null, 1)}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
        <MetricNote>
          Review counts include approvals and substantive comments, and exclude an author commenting
          on their own merge request.
        </MetricNote>
      </section>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="tnum text-sm font-semibold">{value}</div>
    </div>
  )
}
