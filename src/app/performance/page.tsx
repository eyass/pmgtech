import Link from 'next/link'

import { TeamDimensions } from '@/components/performance'
import { Card, MetricNote, Pill, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { nf, pct } from '@/lib/format'
import {
  getEngineerProfiles,
  getKnowledgeConcentration,
  getMetricTargets,
  getPerformanceDimensions,
  getTeamHealth,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Measurement framework — PMG Engineering Tracker' }

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const { key, range } = resolvePeriod(period)

  const [dimensions, teams, profiles, concentration, targetSet] = await Promise.all([
    getPerformanceDimensions(),
    getTeamHealth(range),
    getEngineerProfiles(range),
    getKnowledgeConcentration(range),
    // The thresholds these numbers are coloured against are rows now, editable on
    // /admin. The constants in lib/types/performance.ts are the fallback behind them.
    getMetricTargets(),
  ])

  const shapes = profiles.reduce<Record<string, number>>((acc, p) => {
    acc[p.shape] = (acc[p.shape] ?? 0) + 1
    return acc
  }, {})
  const noRead = profiles.filter((p) => !p.sample_sufficient || p.peers_at_level < 3).length
  const atRisk = concentration.filter((c) => (c.top_author_share_pct ?? 0) >= 60)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Measurement framework</h1>
        <p className="text-sm text-[var(--color-muted)]">{PERIODS[key].label}</p>
      </div>

      {/* --- the framework itself ---------------------------------------------- */}

      <section>
        <Card>
          <h2 className="text-sm font-semibold">Telemetry describes. Humans evaluate.</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--color-muted)]">
            Four dimensions, used at two altitudes. At <strong>team level</strong> these are
            performance metrics and it is reasonable to manage on them. At{' '}
            <strong>individual level</strong> they are inputs to a conversation: a profile shape and
            a within-level band here, and a 0-100 score against the same level cohort on{' '}
            <Link href="/outliers" className="underline">
              Outliers
            </Link>
            . Impact contributes nothing to that score, because there is no telemetry for it — which
            is the honest statement of the score&apos;s ceiling. The performance assessment of record
            is the one a human writes, and there is a place to record it on each person&apos;s page.
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {dimensions.map((d) => (
              <div key={d.key} className="rounded-lg border border-[var(--color-line)] p-3">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold">{d.name}</h3>
                  {d.key === 'impact' ? <Pill tone="warn">human-assessed</Pill> : null}
                </div>
                <dl className="mt-2 space-y-1.5 text-xs">
                  <div>
                    <dt className="inline font-medium">Team: </dt>
                    <dd className="inline italic text-[var(--color-muted)]">{d.team_question}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Person: </dt>
                    <dd className="inline italic text-[var(--color-muted)]">
                      {d.individual_question}
                    </dd>
                  </div>
                  <div className="pt-1">
                    <dt className="font-medium">Sees</dt>
                    <dd className="text-[var(--color-muted)]">{d.what_it_sees}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-amber-700 dark:text-amber-400">
                      Cannot see
                    </dt>
                    <dd className="text-[var(--color-muted)]">{d.what_it_cannot_see}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-lg bg-[var(--color-canvas)] p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide">
              Why this resists gaming
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-muted)]">
              Every output metric is paired with a counter-metric, so pushing one alone shows up as a
              regression in the other. Throughput is paired with review coverage and reverts. Speed
              is paired with merge-request size and change failure rate. Reviews given is paired with
              review depth, so approving without reading is visible. Points closed is paired with
              unplanned-work share.
            </p>
          </div>
        </Card>
      </section>

      {/* --- team scorecards --------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Team level"
          hint="One block per dimension, per squad. Colour is against an absolute target — the only place in the app where that happens, and it applies to squads, never to people."
          action={
            <Link href="/admin#targets" className="text-xs text-[var(--color-muted)] underline">
              {targetSet.usingFallback ? 'Targets unavailable — using defaults' : 'Edit the targets'}
            </Link>
          }
        />
        <div className="space-y-6">
          {teams.map((team) => (
            <div key={team.squad_id}>
              <div className="mb-2 flex items-center justify-between">
                <SquadBadge
                  squadKey={team.squad_key}
                  name={team.squad_name}
                  href={`/squads/${team.squad_key}?period=${key}`}
                />
                <span className="text-xs text-[var(--color-muted)]">
                  {nf(team.headcount)} engineers
                </span>
              </div>
              <TeamDimensions team={team} targets={targetSet.targets} />
            </div>
          ))}
        </div>
      </section>

      {/* --- how the individual view behaves ----------------------------------- */}

      <section>
        <SectionHeading
          title="Individual level"
          hint="Distribution of profile shapes across the org. Open a person's page for their full profile and to record an assessment."
        />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {(['Anchor', 'Shipper', 'Multiplier', 'Quiet in telemetry'] as const).map((shape) => (
            <Card key={shape}>
              <div className="text-xs text-[var(--color-muted)]">{shape}</div>
              <div className="tnum text-2xl font-semibold">{nf(shapes[shape] ?? 0)}</div>
            </Card>
          ))}
          <Card className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
            <div className="text-xs text-[var(--color-muted)]">No comparative read</div>
            <div className="tnum text-2xl font-semibold">{nf(noRead)}</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">
              Too few MRs, or too few peers at level
            </div>
          </Card>
        </div>

        <MetricNote>
          A shape is a description, not a grade. &ldquo;Multiplier&rdquo; is frequently the right
          shape for a senior engineer, and &ldquo;Quiet in telemetry&rdquo; means this tool cannot
          see the work — design, incidents, pairing and on-call all produce no merge requests.
        </MetricNote>

        <div className="mt-4">
          <Table
            empty="No engineers yet — run the HiBob sync to build the directory."
            head={
              <>
                <Th>Engineer</Th>
                <Th>Level</Th>
                <Th>Squad</Th>
                <Th>Shape</Th>
                <Th align="right">Flow</Th>
                <Th align="right">Quality</Th>
                <Th align="right">Collaboration</Th>
                <Th align="right" title="Peers at the same seniority level">
                  Cohort
                </Th>
              </>
            }
          >
            {profiles.map((p) => (
              <tr key={p.engineer_id}>
                <Td>
                  <Link href={`/people/${p.engineer_id}?period=${key}`} className="hover:underline">
                    {p.full_name}
                  </Link>
                </Td>
                <Td className="text-xs">{p.seniority_label ?? p.seniority_key}</Td>
                <Td>
                  <SquadBadge squadKey={p.squad_key} name={p.squad_name ?? 'Unassigned'} />
                </Td>
                <Td>
                  <span className="text-xs">{p.shape}</span>
                </Td>
                <Td align="right" className="text-xs">
                  {p.flow_band === 'insufficient' ? '—' : p.flow_band}
                </Td>
                <Td align="right" className="text-xs">
                  {p.quality_band === 'insufficient' ? '—' : p.quality_band}
                </Td>
                <Td align="right" className="text-xs">
                  {p.collaboration_band === 'insufficient' ? '—' : p.collaboration_band}
                </Td>
                <Td align="right" numeric>
                  {nf(p.peers_at_level)}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      </section>

      {/* --- bus factor -------------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Knowledge concentration"
          hint="Where one person wrote most of a repository. A staffing risk that none of the other numbers surface."
        />
        {atRisk.length > 0 ? (
          <Card className="mb-3 border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
            <p className="text-sm">
              <strong>{atRisk.length}</strong>{' '}
              {atRisk.length === 1 ? 'repository has' : 'repositories have'} 60% or more of their
              commits from a single author in this period.
            </p>
          </Card>
        ) : null}
        <Table
          empty="Not enough commit history yet. Repositories with fewer than 10 commits in the period are excluded."
          head={
            <>
              <Th>Repository</Th>
              <Th>Squad</Th>
              <Th align="right">Contributors</Th>
              <Th align="right">Commits</Th>
              <Th>Top author</Th>
              <Th align="right">Their share</Th>
            </>
          }
        >
          {concentration.slice(0, 25).map((row) => (
            <tr key={row.project_id}>
              <Td>{row.project_name}</Td>
              <Td>
                <SquadBadge squadKey={row.squad_key} name={row.squad_key ?? 'Unassigned'} />
              </Td>
              <Td align="right" numeric>
                {row.contributors === 1 ? (
                  <span className="text-red-600 dark:text-red-400">1</span>
                ) : (
                  nf(row.contributors)
                )}
              </Td>
              <Td align="right" numeric>
                {nf(row.commits)}
              </Td>
              <Td className="text-xs">{row.top_author_name}</Td>
              <Td align="right" numeric>
                <span
                  className={
                    (row.top_author_share_pct ?? 0) >= 80
                      ? 'text-red-600 dark:text-red-400'
                      : (row.top_author_share_pct ?? 0) >= 60
                        ? 'text-amber-600 dark:text-amber-400'
                        : ''
                  }
                >
                  {pct(row.top_author_share_pct, 1)}
                </span>
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      {/* --- how to run a review ----------------------------------------------- */}

      <section>
        <SectionHeading title="Running a review with this" />
        <Card>
          <ol className="max-w-3xl list-decimal space-y-2 pl-5 text-sm leading-relaxed">
            <li>
              <strong>Read the team page first.</strong> Most of what looks like an individual
              problem is a system one. If flow efficiency is 12%, nobody on that squad is going to
              look fast, and coaching them on speed is the wrong intervention.
            </li>
            <li>
              <strong>Open the person&apos;s profile and look at the shape, not the counts.</strong>{' '}
              Ask whether the shape matches what you asked of them. A senior on &ldquo;Shipper&rdquo;
              may be avoiding review work; a mid-level on &ldquo;Multiplier&rdquo; may be blocked on
              their own work.
            </li>
            <li>
              <strong>Treat every band as a question.</strong> &ldquo;Your cycle time is longer than
              others at your level — what&apos;s in the way?&rdquo; is useful. &ldquo;Your cycle time
              is below target&rdquo; is not, because there is no individual target here by design.
            </li>
            <li>
              <strong>Write the Impact assessment yourself.</strong> It is the dimension that
              matters most and the one telemetry cannot reach. The form on each person&apos;s page
              asks for evidence alongside the rating, so the review is reconstructable in six
              months.
            </li>
            <li>
              <strong>Check the &ldquo;no comparative read&rdquo; list.</strong> Those people are not
              low performers; they are invisible to this tool. Assess them entirely on human input.
            </li>
          </ol>
        </Card>
      </section>
    </div>
  )
}
