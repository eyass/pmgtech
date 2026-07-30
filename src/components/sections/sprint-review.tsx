import Link from 'next/link'

import { SprintBarChart } from '@/components/charts'
import { Card, Kpi, MetricNote, Pill, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { nf, pct, shortDate } from '@/lib/format'
import { getSprintScorecards, getSquads } from '@/lib/queries'

/**
 * Sprint commitment and carryover, lifted out of its own page.
 *
 * It used to be `/sprints`. Sprint scope creep and carryover are flow facts about
 * the same delivery the rest of that page measures, so a separate nav entry made
 * two views of one subject look like two subjects. Its own `<h1>` became a section
 * heading and its squad filter now points at `/delivery`; nothing else changed.
 */
export async function SprintReview({ squadFilter }: { squadFilter?: string }) {

  const squads = await getSquads()
  const selected = squadFilter ? squads.find((s) => s.key === squadFilter) : undefined
  const sprints = await getSprintScorecards(selected?.id, selected ? 12 : 20)

  const closed = sprints.filter((s) => s.state === 'closed')
  const avgCompletion = mean(closed.map((s) => s.completion_pct))
  const avgScopeCreep = mean(closed.map((s) => s.scope_creep_pct))
  const totalCarryover = closed.reduce((sum, s) => sum + s.carryover_issues, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeading
          title="Sprints"
          hint={`${selected ? selected.name : 'All squads'} · most recent first`}
        />

        <div className="flex flex-wrap gap-1">
          <FilterLink href="/delivery" label="All" active={!selected} />
          {squads.map((s) => (
            <FilterLink
              key={s.key}
              href={`/delivery?squad=${s.key}`}
              label={s.name.replace(/^Team /, '')}
              active={selected?.key === s.key}
            />
          ))}
        </div>
      </div>

      {sprints.length === 0 ? (
        <Card>
          <h2 className="text-sm font-semibold">No sprints yet</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Sprints arrive with the Jira sync. Each Jira board needs mapping to a squad on the{' '}
            <Link href="/admin" className="underline">
              admin page
            </Link>{' '}
            — until then sprints exist but are not attributed to a team.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {/* Sprint averages come from however many sprints Jira has closed, which is a
                handful per board — small enough that the count belongs next to the number. */}
            <Kpi
              label="Average completion"
              value={pct(avgCompletion, 1)}
              hint="Issues completed as a share of the sprint's final scope"
              direction="higher-better"
              raw={avgCompletion}
              thresholds={{ good: 80, bad: 50 }}
              sample={closed.length}
              sampleUnit="closed sprints"
              sampleFloor={4}
            />
            <Kpi
              label="Average scope creep"
              value={pct(avgScopeCreep, 1)}
              hint="Share of sprint issues added after the start date"
              direction="lower-better"
              raw={avgScopeCreep}
              thresholds={{ good: 10, bad: 30 }}
              sample={closed.length}
              sampleUnit="closed sprints"
              sampleFloor={4}
            />
            <Kpi
              label="Carryover issues"
              value={nf(totalCarryover)}
              hint="Unfinished and not Done at sprint close"
            />
          </div>

          <Card>
            <SectionHeading
              title="Commitment versus delivery"
              hint="Grey plus amber is the total scope the sprint ended up with; green is what was completed."
            />
            <SprintBarChart sprints={sprints.slice(0, 12)} height={280} />
          </Card>

          <Table
            empty="No sprints to show."
            head={
              <>
                <Th>Sprint</Th>
                {!selected ? <Th>Squad</Th> : null}
                <Th>Dates</Th>
                <Th align="right" title="Issues in the sprint at its start">
                  Committed
                </Th>
                <Th align="right" title="Issues added after the sprint started">
                  Added
                </Th>
                <Th align="right">Total</Th>
                <Th align="right">Completed</Th>
                <Th align="right" title="Not completed and not in a Done status">
                  Carryover
                </Th>
                <Th align="right">Completion</Th>
                <Th align="right" title="Story points committed versus completed">
                  Points
                </Th>
              </>
            }
          >
            {sprints.map((sprint) => (
              <tr key={sprint.sprint_id}>
                <Td>
                  {sprint.sprint_name}
                  {sprint.goal ? (
                    <div className="max-w-xs truncate text-xs text-[var(--color-muted)]" title={sprint.goal}>
                      {sprint.goal}
                    </div>
                  ) : null}
                </Td>
                {!selected ? (
                  <Td>
                    <SquadBadge squadKey={sprint.squad_key} name={sprint.squad_key ?? 'Unmapped'} />
                  </Td>
                ) : null}
                <Td>
                  <span className="text-xs">
                    {shortDate(sprint.start_date)} – {shortDate(sprint.end_date)}
                  </span>
                  {sprint.state === 'active' ? <Pill tone="warn">active</Pill> : null}
                </Td>
                <Td align="right" numeric>{nf(sprint.committed_issues)}</Td>
                <Td align="right" numeric>
                  {sprint.added_issues > 0 ? (
                    <span className="text-amber-600 dark:text-amber-400">+{nf(sprint.added_issues)}</span>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td align="right" numeric>{nf(sprint.total_issues)}</Td>
                <Td align="right" numeric>{nf(sprint.completed_issues)}</Td>
                <Td align="right" numeric>
                  {sprint.carryover_issues > 0 ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      {nf(sprint.carryover_issues)}
                    </span>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td align="right" numeric>
                  <CompletionCell pct={sprint.completion_pct} />
                </Td>
                <Td align="right" numeric>
                  {/* Most issues in this instance carry no estimate, so "0 / 0" would read
                      as a sprint that delivered nothing rather than one nobody pointed. */}
                  {sprint.committed_points === 0 && sprint.completed_points === 0 ? (
                    <span className="text-[var(--color-muted)]" title="No issues in this sprint carry a story-point estimate">
                      not estimated
                    </span>
                  ) : (
                    `${nf(sprint.completed_points, 1)} / ${nf(sprint.committed_points, 1)}`
                  )}
                </Td>
              </tr>
            ))}
          </Table>

          <MetricNote>
            Committed versus added is reconstructed from the Jira changelog: an issue counts as
            committed if it was in the sprint before the start date, and as added if it joined
            afterwards. Sprints whose changelog has been truncated by Jira fall back to the sprint
            start date, which can understate scope creep on very old sprints. Story points are
            recorded on under a tenth of issues here, so point columns describe estimating habits
            more than delivery — issue counts are the reliable measure on this page.
          </MetricNote>
        </>
      )}
    </div>
  )
}

function CompletionCell({ pct: value }: { pct: number | null }) {
  if (value === null) return <>—</>
  const tone =
    value >= 80 ? 'text-emerald-600 dark:text-emerald-400' : value >= 50 ? '' : 'text-red-600 dark:text-red-400'
  return <span className={tone}>{pct(value)}</span>
}

function FilterLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-2.5 py-1 text-xs ${
        active
          ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
          : 'border border-[var(--color-line)] text-[var(--color-muted)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
    </Link>
  )
}

function mean(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}
