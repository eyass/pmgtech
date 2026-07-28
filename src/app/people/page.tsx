import Link from 'next/link'

import { Card, MetricNote, Pill, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { compact, hours, nf, relativeDate } from '@/lib/format'
import {
  getEngineerScorecards,
  getSeniorityBenchmark,
  getSquads,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'

export const dynamic = 'force-dynamic'

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; squad?: string }>
}) {
  const { period, squad: squadFilter } = await searchParams
  const { key, range } = resolvePeriod(period)

  const squads = await getSquads()
  const selected = squadFilter ? squads.find((s) => s.key === squadFilter) : undefined

  const [engineers, benchmark] = await Promise.all([
    getEngineerScorecards(range, selected?.id),
    getSeniorityBenchmark(range, selected?.id),
  ])

  const unassigned = engineers.filter((e) => !e.squad_id)
  const unknownLevel = engineers.filter((e) => e.seniority_key === 'unknown')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">People</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {PERIODS[key].label} · {engineers.length} engineers
            {selected ? ` in ${selected.name}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap gap-1">
          <FilterLink href={`/people?period=${key}`} label="All" active={!selected} />
          {squads.map((s) => (
            <FilterLink
              key={s.key}
              href={`/people?period=${key}&squad=${s.key}`}
              label={s.name.replace(/^Team /, '')}
              active={selected?.key === s.key}
            />
          ))}
        </div>
      </div>

      <Card className="border-[var(--color-line)]">
        <p className="text-sm">
          <strong>How to read this page.</strong> These are activity counts, not performance
          ratings. Volume depends heavily on the kind of work someone is assigned, how much of their
          time goes to reviewing, mentoring, incidents and design, and none of that appears in a
          merge-request count. Use it to spot patterns worth a conversation — someone carrying the
          whole review load, someone with no activity who may be blocked — rather than to rank people.
        </p>
      </Card>

      {(unassigned.length > 0 || unknownLevel.length > 0) && (
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-sm">
            {unassigned.length > 0 ? (
              <>
                <strong>{unassigned.length}</strong> engineers have no squad, so their work is
                attributed to the repository owner instead of a team.{' '}
              </>
            ) : null}
            {unknownLevel.length > 0 ? (
              <>
                <strong>{unknownLevel.length}</strong> have no recognised seniority from their HiBob
                job title.{' '}
              </>
            ) : null}
            Fix both on the{' '}
            <Link href="/admin" className="underline">
              admin page
            </Link>
            .
          </p>
        </Card>
      )}

      <Table
        empty="No engineers yet — run the HiBob sync to build the directory."
        head={
          <>
            <Th>Engineer</Th>
            <Th>Squad</Th>
            <Th>Level</Th>
            <Th align="right" title="Merge requests merged in the period">
              Merged
            </Th>
            <Th align="right" title="Median first commit to merge">
              Lead time
            </Th>
            <Th align="right" title="Median lines changed per merge request">
              MR size
            </Th>
            <Th align="right" title="Reviews given on other people's merge requests">
              Reviews
            </Th>
            <Th align="right" title="Distinct colleagues whose code this person reviewed">
              Reach
            </Th>
            <Th align="right" title="Median hours from MR open to this person's first comment">
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
              {eng.squad_id ? (
                <SquadBadge
                  squadKey={eng.squad_key}
                  name={eng.squad_name}
                  href={`/squads/${eng.squad_key}?period=${key}`}
                />
              ) : (
                <Pill tone="warn">unassigned</Pill>
              )}
            </Td>
            <Td>
              {eng.seniority_key === 'unknown' ? (
                <Pill tone="warn">unknown</Pill>
              ) : (
                <span className="text-sm">{eng.seniority_label}</span>
              )}
              {eng.tenure_months !== null && eng.tenure_months < 4 ? (
                <div className="text-xs text-[var(--color-muted)]">
                  joined {eng.tenure_months}m ago
                </div>
              ) : null}
            </Td>
            <Td align="right" numeric>{nf(eng.merged_mrs)}</Td>
            <Td align="right" numeric>{hours(eng.median_cycle_hours)}</Td>
            <Td align="right" numeric>{compact(eng.median_mr_churn)}</Td>
            <Td align="right" numeric>{nf(eng.reviews_given)}</Td>
            <Td align="right" numeric>{nf(eng.distinct_authors_reviewed)}</Td>
            <Td align="right" numeric>{hours(eng.median_review_response_hours)}</Td>
            <Td align="right" numeric>{nf(eng.issues_resolved)}</Td>
            <Td align="right">{relativeDate(eng.last_active_at)}</Td>
          </tr>
        ))}
      </Table>

      {benchmark.length > 1 ? (
        <section>
          <SectionHeading
            title="Typical output by level"
            hint="Median per person at each rung of the ladder. Levels with fewer than two people are hidden so nobody is singled out."
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
                <Th align="right">MR size</Th>
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
                <Td align="right" numeric>{compact(row.median_mr_churn)}</Td>
              </tr>
            ))}
          </Table>
          <MetricNote>
            Seniority comes from each person&apos;s HiBob job title, normalised onto a ladder from
            intern to director. Expect senior levels to show fewer merged merge requests and more
            reviews given — that shape is the point of the ladder, not a problem to correct.
          </MetricNote>
        </section>
      ) : null}
    </div>
  )
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
