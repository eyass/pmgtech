import Link from 'next/link'
import { notFound } from 'next/navigation'

import { AssessmentForm } from '@/components/assessment-form'
import { IndividualProfile } from '@/components/performance'
import { Card, Kpi, MetricNote, Pill, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { currentUser } from '@/lib/auth'
import { compact, hours, nf, relativeDate, shortDate } from '@/lib/format'
import {
  currentPeriod,
  getAssessments,
  getAssessmentSummary,
  getEngineer,
  getEngineerProfiles,
  getEngineerScorecards,
  getPerformanceDimensions,
  getSeniorityBenchmark,
  getSquads,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'
import { supabaseAdmin } from '@/lib/supabase/admin'

import { saveAssessment } from './actions'

export const dynamic = 'force-dynamic'

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ period?: string }>
}) {
  const { id } = await params
  const { period } = await searchParams
  const { key, range } = resolvePeriod(period)

  const engineer = await getEngineer(id)
  if (!engineer) notFound()

  const reviewPeriod = currentPeriod()
  const [scorecards, benchmark, squads, recentMrs, identities, profiles, dimensions, assessments, summary, user] =
    await Promise.all([
      getEngineerScorecards(range),
      getSeniorityBenchmark(range),
      getSquads(),
      getRecentMergeRequests(id),
      getIdentities(id),
      getEngineerProfiles(range, undefined, id),
      getPerformanceDimensions(),
      getAssessments(id, reviewPeriod.start, reviewPeriod.end),
      getAssessmentSummary(id, reviewPeriod.start, reviewPeriod.end),
      currentUser(),
    ])
  const profile = profiles[0]

  const me = scorecards.find((s) => s.engineer_id === id)
  const squad = squads.find((s) => s.id === engineer.squad_id)
  const peerLevel = benchmark.find((b) => b.seniority_key === engineer.seniority_key)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{engineer.display_name ?? engineer.full_name}</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {engineer.job_title ?? 'No job title from HiBob'}
            {squad ? ' · ' : ''}
            {squad ? <SquadBadge squadKey={squad.key} name={squad.name} href={`/squads/${squad.key}?period=${key}`} /> : null}
          </p>
        </div>
        <Link href={`/people?period=${key}`} className="text-sm text-[var(--color-muted)] hover:underline">
          ← All people
        </Link>
      </div>

      {!engineer.is_active ? (
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-sm">
            This person is marked inactive in HiBob. Their historical contribution is kept so past
            periods stay accurate, but they are excluded from current headcount.
          </p>
        </Card>
      ) : null}

      {/* --- HR context ------------------------------------------------------- */}

      <Card>
        <SectionHeading title="From HiBob" hint="Read-only; edit in HiBob and re-sync." />
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <Field label="Email" value={engineer.email ?? '—'} />
          <Field label="Level" value={engineer.seniority_key === 'unknown' ? 'Not recognised' : engineer.seniority_key} />
          <Field label="Department" value={engineer.department ?? '—'} />
          <Field label="Started" value={shortDate(engineer.start_date)} />
          <Field label="Site" value={engineer.site ?? '—'} />
          <Field label="Employment" value={engineer.employment_type ?? '—'} />
          <Field label="Manager" value={engineer.manager_email ?? '—'} />
          <Field
            label="Squad source"
            value={engineer.squad_source === 'manual' ? 'Set manually' : engineer.squad_source}
          />
          <Field
            label="Level source"
            value={engineer.seniority_source === 'manual' ? 'Set manually' : engineer.seniority_source}
          />
        </dl>
      </Card>

      {/* --- activity --------------------------------------------------------- */}

      {me ? (
        <>
          <p className="text-sm text-[var(--color-muted)]">{PERIODS[key].label}</p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Merged MRs"
              value={nf(me.merged_mrs)}
              hint={
                peerLevel
                  ? `Median at ${peerLevel.seniority_label}: ${nf(peerLevel.median_merged_mrs, 1)}`
                  : undefined
              }
            />
            <Kpi
              label="Lead time"
              value={hours(me.median_cycle_hours)}
              hint={
                peerLevel ? `Median at level: ${hours(peerLevel.median_cycle_hours)}` : undefined
              }
            />
            <Kpi
              label="Reviews given"
              value={nf(me.reviews_given)}
              hint={`Across ${nf(me.distinct_authors_reviewed)} different authors`}
            />
            <Kpi
              label="Issues resolved"
              value={nf(me.issues_resolved)}
              hint={`${nf(me.story_points)} points · ${nf(me.bugs_resolved)} bugs`}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Commits" value={nf(me.commits)} hint="Excluding merge commits" />
            <Kpi label="Code churn" value={compact(me.code_churn)} hint="Lines added plus removed" />
            <Kpi
              label="Review response"
              value={hours(me.median_review_response_hours)}
              hint="Median from MR open to their first comment"
            />
            <Kpi
              label="Reviews received"
              value={nf(me.reviews_received)}
              hint="Comments and approvals on their own MRs"
            />
          </div>

          <MetricNote>
            Compared against the median for their own level rather than the whole org, since a
            senior engineer and a junior are not expected to produce the same shape of output. A
            level with fewer than two people has no median, so no comparison is shown.
          </MetricNote>
        </>
      ) : (
        <Card>
          <p className="text-sm text-[var(--color-muted)]">
            No activity metrics available. This happens when the person is excluded from metrics, or
            when their GitLab and Jira accounts have not been linked yet — check the unmapped
            identities list on the{' '}
            <Link href="/admin" className="underline">
              admin page
            </Link>
            .
          </p>
        </Card>
      )}

      {/* --- four-dimension profile ------------------------------------------- */}

      {profile ? (
        <section>
          <SectionHeading
            title="Profile"
            hint="Bands compare against others at the same seniority level, and are suppressed when the sample is too small. There is no composite score by design."
          />
          <IndividualProfile profile={profile} />
        </section>
      ) : null}

      {/* --- assessment: the human half --------------------------------------- */}

      <section>
        <SectionHeading
          title={`Assessment — ${reviewPeriod.label}`}
          hint="The performance assessment of record. Impact in particular is human-only: telemetry cannot see business value or judgement."
        />
        {user?.isAdmin ? (
          <Card>
            <AssessmentForm
              action={saveAssessment}
              engineerId={id}
              engineerName={engineer.display_name ?? engineer.full_name}
              periodStart={reviewPeriod.start}
              periodEnd={reviewPeriod.end}
              periodLabel={reviewPeriod.label}
              dimensions={dimensions}
              existing={assessments}
              summary={summary}
            />
          </Card>
        ) : (
          <Card>
            <p className="text-sm text-[var(--color-muted)]">
              Assessments are visible to admins only. Ask an engineering manager if you need access.
            </p>
          </Card>
        )}
      </section>

      {/* --- linked accounts -------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Linked accounts"
          hint="How this person's GitLab, Jira and commit-email identities are resolved."
        />
        <Table
          empty="No external identities linked. Their GitLab and Jira activity will not be attributed until one is."
          head={
            <>
              <Th>Source</Th>
              <Th>Identifier</Th>
              <Th>Handle</Th>
            </>
          }
        >
          {identities.map((identity) => (
            <tr key={`${identity.provider}-${identity.external_id}`}>
              <Td>
                <Pill>{identity.provider}</Pill>
              </Td>
              <Td className="font-mono text-xs">{identity.external_id}</Td>
              <Td>{identity.external_handle ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      </section>

      {/* --- recent work ------------------------------------------------------ */}

      <section>
        <SectionHeading title="Recent merge requests" hint="Twenty most recent, newest first." />
        <Table
          empty="No merge requests recorded for this person."
          head={
            <>
              <Th>Title</Th>
              <Th>Project</Th>
              <Th>State</Th>
              <Th align="right">Size</Th>
              <Th align="right">Reviewers</Th>
              <Th align="right">Merged</Th>
            </>
          }
        >
          {recentMrs.map((mr) => (
            <tr key={mr.id}>
              <Td>
                <a href={mr.web_url ?? '#'} target="_blank" rel="noreferrer" className="hover:underline">
                  {mr.title ?? 'Untitled'}
                </a>
              </Td>
              <Td className="text-xs text-[var(--color-muted)]">{mr.project_name}</Td>
              <Td>
                <Pill tone={mr.state === 'merged' ? 'good' : mr.state === 'closed' ? 'bad' : 'neutral'}>
                  {mr.state}
                </Pill>
              </Td>
              <Td align="right" numeric>{compact(mr.churn)}</Td>
              <Td align="right" numeric>{nf(mr.distinct_reviewers)}</Td>
              <Td align="right">{mr.merged_at ? relativeDate(mr.merged_at) : '—'}</Td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  )
}

interface RecentMr {
  id: string
  title: string | null
  web_url: string | null
  project_name: string
  state: string
  churn: number
  distinct_reviewers: number
  merged_at: string | null
}

async function getRecentMergeRequests(engineerId: string): Promise<RecentMr[]> {
  const { data, error } = await supabaseAdmin()
    .from('v_merge_requests')
    .select('id, title, web_url, project_name, state, churn, distinct_reviewers, merged_at, opened_at')
    .eq('author_engineer_id', engineerId)
    .order('opened_at', { ascending: false })
    .limit(20)
  if (error) throw new Error(`Failed to load merge requests: ${error.message}`)
  return (data ?? []) as RecentMr[]
}

interface Identity {
  provider: string
  external_id: string
  external_handle: string | null
}

async function getIdentities(engineerId: string): Promise<Identity[]> {
  const { data, error } = await supabaseAdmin()
    .from('engineer_identities')
    .select('provider, external_id, external_handle')
    .eq('engineer_id', engineerId)
    .order('provider')
  if (error) throw new Error(`Failed to load identities: ${error.message}`)
  return (data ?? []) as Identity[]
}
