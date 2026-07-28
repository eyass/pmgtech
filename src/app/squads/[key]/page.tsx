import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SprintBarChart, TrendChart } from '@/components/charts'
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
import { compact, hours, nf, pct, relativeDate, shortDate } from '@/lib/format'
import {
  getAttentionList,
  getDeliveryTrend,
  getEngineerScorecards,
  getSeniorityBenchmark,
  getSprintScorecards,
  getSquadByKey,
  getSquadScorecards,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'

export const dynamic = 'force-dynamic'

export default async function SquadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>
  searchParams: Promise<{ period?: string }>
}) {
  const { key: squadKey } = await params
  const { period } = await searchParams
  const { key, range, bucket } = resolvePeriod(period)

  const squad = await getSquadByKey(squadKey)
  if (!squad) notFound()

  const [allSquads, trend, engineers, sprints, attention, benchmark] = await Promise.all([
    getSquadScorecards(range),
    getDeliveryTrend(range, bucket, squad.id),
    getEngineerScorecards(range, squad.id),
    getSprintScorecards(squad.id, 6),
    getAttentionList(squad.id, 15),
    getSeniorityBenchmark(range, squad.id),
  ])

  const scorecard = allSquads.find((s) => s.squad_id === squad.id)
  const orgMedianCycle = median(allSquads.map((s) => s.median_cycle_hours))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SquadBadge squadKey={squad.key} name={squad.name} />
          <h1 className="mt-1 text-xl font-semibold">{squad.name}</h1>
          {squad.description ? (
            <p className="text-sm text-[var(--color-muted)]">{squad.description}</p>
          ) : null}
        </div>
        <Link href={`/squads?period=${key}`} className="text-sm text-[var(--color-muted)] hover:underline">
          ← All squads
        </Link>
      </div>

      <p className="text-sm text-[var(--color-muted)]">{PERIODS[key].label}</p>

      {scorecard ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Merged MRs"
            value={nf(scorecard.merged_mrs)}
            hint={`${nf(scorecard.mrs_per_engineer_week, 2)} per engineer per week`}
          />
          <Kpi
            label="Lead time"
            value={hours(scorecard.median_cycle_hours)}
            hint={`Org median ${hours(orgMedianCycle)} · p75 ${hours(scorecard.p75_cycle_hours)}`}
            direction="lower-better"
            raw={scorecard.median_cycle_hours}
            thresholds={{ good: 24, bad: 120 }}
          />
          <Kpi
            label="Review wait"
            value={hours(scorecard.median_review_wait_hours)}
            hint={`${pct(scorecard.review_coverage_pct)} of MRs reviewed`}
            direction="lower-better"
            raw={scorecard.median_review_wait_hours}
            thresholds={{ good: 4, bad: 24 }}
          />
          <Kpi
            label="Deploys"
            value={`${nf(scorecard.deploys_per_week, 1)}/wk`}
            hint={`${pct(scorecard.change_failure_pct, 1)} change failure · ${hours(scorecard.mttr_hours)} to restore`}
            direction="higher-better"
            raw={scorecard.deploys_per_week}
            thresholds={{ good: 5, bad: 0.5 }}
          />
        </div>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionHeading title="Throughput" hint={`Merged merge requests by ${bucket}`} />
          <TrendChart points={trend} metric="merged_mrs" bucket={bucket} squadKeys={[squad.key]} />
        </Card>
        <Card>
          <SectionHeading title="Lead time" hint="Median hours, first commit to merge" />
          <TrendChart
            points={trend}
            metric="median_cycle_hours"
            bucket={bucket}
            squadKeys={[squad.key]}
          />
        </Card>
      </section>

      {/* --- sprints ---------------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Recent sprints"
          hint="Committed at sprint start versus added mid-sprint versus actually completed."
          action={
            <Link href={`/sprints?squad=${squad.key}`} className="text-sm text-[var(--color-muted)] hover:underline">
              All sprints →
            </Link>
          }
        />
        {sprints.length > 0 ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <Card>
              <SprintBarChart sprints={sprints} />
            </Card>
            <Table
              empty="No sprints for this squad yet."
              head={
                <>
                  <Th>Sprint</Th>
                  <Th align="right">Committed</Th>
                  <Th align="right" title="Issues added after the sprint started">
                    Added
                  </Th>
                  <Th align="right">Done</Th>
                  <Th align="right">Completion</Th>
                </>
              }
            >
              {sprints.map((sprint) => (
                <tr key={sprint.sprint_id}>
                  <Td>
                    {sprint.sprint_name}
                    <div className="text-xs text-[var(--color-muted)]">
                      {shortDate(sprint.start_date)} – {shortDate(sprint.end_date)}
                      {sprint.state === 'active' ? (
                        <Pill tone="warn">
                          <span className="ml-1">active</span>
                        </Pill>
                      ) : null}
                    </div>
                  </Td>
                  <Td align="right" numeric>{nf(sprint.committed_issues)}</Td>
                  <Td align="right" numeric>
                    {sprint.added_issues > 0 ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        +{nf(sprint.added_issues)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td align="right" numeric>{nf(sprint.completed_issues)}</Td>
                  <Td align="right" numeric>{pct(sprint.completion_pct)}</Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : (
          <Card>
            <p className="text-sm text-[var(--color-muted)]">
              No sprints are mapped to this squad yet. Map a Jira board to{' '}
              <strong>{squad.name}</strong> on the{' '}
              <Link href="/admin" className="underline">
                admin page
              </Link>{' '}
              and sprint metrics will appear here.
            </p>
          </Card>
        )}
      </section>

      {/* --- people ----------------------------------------------------------- */}

      <section>
        <SectionHeading
          title="People"
          hint="Individual activity within the squad. Read alongside seniority and tenure, not as a ranking."
        />
        <Table
          empty="No engineers are assigned to this squad yet."
          head={
            <>
              <Th>Engineer</Th>
              <Th>Level</Th>
              <Th align="right">Merged</Th>
              <Th align="right">Lead time</Th>
              <Th align="right" title="Reviews given to other people's merge requests">
                Reviews given
              </Th>
              <Th align="right" title="Median time from MR open to this person's first comment">
                Response
              </Th>
              <Th align="right">Issues</Th>
              <Th align="right">Last active</Th>
            </>
          }
        >
          {engineers.map((eng) => (
            <tr key={eng.engineer_id}>
              <Td>
                <Link href={`/people/${eng.engineer_id}?period=${key}`} className="hover:underline">
                  {eng.full_name}
                </Link>
                {eng.job_title ? (
                  <div className="text-xs text-[var(--color-muted)]">{eng.job_title}</div>
                ) : null}
              </Td>
              <Td>
                {eng.seniority_key === 'unknown' ? (
                  <Pill tone="warn">unknown</Pill>
                ) : (
                  <span className="text-sm">{eng.seniority_label}</span>
                )}
                {eng.tenure_months !== null && eng.tenure_months < 4 ? (
                  <Pill tone="neutral">
                    <span className="ml-1">new joiner</span>
                  </Pill>
                ) : null}
              </Td>
              <Td align="right" numeric>{nf(eng.merged_mrs)}</Td>
              <Td align="right" numeric>{hours(eng.median_cycle_hours)}</Td>
              <Td align="right" numeric>{nf(eng.reviews_given)}</Td>
              <Td align="right" numeric>{hours(eng.median_review_response_hours)}</Td>
              <Td align="right" numeric>{nf(eng.issues_resolved)}</Td>
              <Td align="right">{relativeDate(eng.last_active_at)}</Td>
            </tr>
          ))}
        </Table>
        <MetricNote>
          Throughput varies enormously with the kind of work someone is doing. A staff engineer
          unblocking four other people can show fewer merged MRs than a junior working through a
          well-defined backlog, and that is usually the right outcome.
        </MetricNote>
      </section>

      {benchmark.length > 1 ? (
        <section>
          <SectionHeading
            title="By seniority within this squad"
            hint="Median per person at each level. Levels with only one person are hidden."
          />
          <Table
            empty="Not enough people per level to compare."
            head={
              <>
                <Th>Level</Th>
                <Th align="right">People</Th>
                <Th align="right">Merged MRs</Th>
                <Th align="right">Lead time</Th>
                <Th align="right">Reviews given</Th>
                <Th align="right">Issues</Th>
              </>
            }
          >
            {benchmark.map((row) => (
              <tr key={row.seniority_key}>
                <Td>{row.seniority_label}</Td>
                <Td align="right" numeric>{nf(row.engineers)}</Td>
                <Td align="right" numeric>{nf(row.median_merged_mrs, 1)}</Td>
                <Td align="right" numeric>{hours(row.median_cycle_hours)}</Td>
                <Td align="right" numeric>{nf(row.median_reviews_given, 1)}</Td>
                <Td align="right" numeric>{nf(row.median_issues_resolved, 1)}</Td>
              </tr>
            ))}
          </Table>
        </section>
      ) : null}

      {/* --- attention -------------------------------------------------------- */}

      <section>
        <SectionHeading title="Open merge requests needing attention" />
        <Table
          empty="Nothing stuck in this squad."
          head={
            <>
              <Th>Merge request</Th>
              <Th>Author</Th>
              <Th align="right">Age</Th>
              <Th align="right">Size</Th>
              <Th align="right">Reviewers</Th>
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
              <Td>{row.author_name}</Td>
              <Td align="right" numeric>{hours(row.age_hours)}</Td>
              <Td align="right" numeric>{compact(row.churn)}</Td>
              <Td align="right" numeric>{nf(row.distinct_reviewers)}</Td>
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

function median(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null).sort((a, b) => a - b)
  if (nums.length === 0) return null
  const mid = Math.floor(nums.length / 2)
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid]
}
