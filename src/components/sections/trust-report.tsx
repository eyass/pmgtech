import Link from 'next/link'

import { CoverageMeters, GuardSummary, type CoverageMeterRow } from '@/components/coverage-meter'
import { SyncAlertBanner } from '@/components/coverage'
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
import { hours, nf, pct, relativeDate } from '@/lib/format'
import type { OrgKpis, UnmatchedIdentityRow } from '@/lib/types/metrics'
import {
  guardLevel,
  MIN_COHORT,
  orgWithholdings,
  readAttribution,
  readScored,
  readVerdict,
  type Guard,
  type SourceHealth,
  type TrustClause,
  type TrustLevel,
  type TrustVerdict,
} from '@/lib/trust'
import {
  COMPLEXITY_COVERAGE_FLOOR,
  type EngineerOutlier,
  type SquadOutlier,
} from '@/lib/types/performance'

/** Who the numbers are about, counted rather than listed. */
export interface TrustPeople {
  /** Everyone HiBob knows about, including every group below. */
  directory: number
  /** The denominator behind every per-engineer rate. */
  inMetrics: number
  ignored: number
  former: number
  excluded: number
}

export interface TrustReportProps {
  /** Label of the period the numbers cover, for the subtitle. */
  periodLabel: string
  kpis: OrgKpis
  sources: SourceHealth[]
  outliers: EngineerOutlier[]
  squads: SquadOutlier[]
  identities: UnmatchedIdentityRow[]
  people: TrustPeople
}

/**
 * How much should you trust today's numbers.
 *
 * Every fact here was already computed and already shown — in the attribution
 * banner, the sync banner, the complexity banner, the confidence column on Outliers,
 * the sample footer under every KPI. The problem was never that the caveats were
 * hidden; it was that they were scattered one per page, each visible only next to the
 * number it qualified, and each visible only when it was bad enough to trip its own
 * threshold. Nobody could answer "is today a day I can quote these numbers in a
 * review" without visiting five pages and remembering which banners had not appeared.
 *
 * So this is deliberately not new analysis. It reads the same values through the same
 * helpers (`readAttribution` is what the banner uses; `readSourceHealth` is what the
 * banner's alerts are built from; the throughput basis and every per-engineer
 * confidence come straight off the RPC rows), and its whole contribution is
 * arrangement: the verdict first, because that is the sentence a reader needs before
 * they quote anything, and the working underneath in the order that decides how wrong
 * a number can be.
 *
 * The one rule it holds itself to that the banners do not: **an unknown coverage
 * figure renders as unknown.** The banners may treat a missing attribution figure as
 * nothing to interrupt about, because interrupting is their job. A page about what we
 * do not know may not round a gap in its own knowledge down to 0% or up to 100%.
 *
 * Every value arrives as a prop and nothing is fetched here, which is what lets the
 * whole report be rendered against real values outside a request.
 */
export function TrustReport({
  periodLabel,
  kpis,
  sources,
  outliers,
  squads,
  identities,
  people,
}: TrustReportProps) {
  const attribution = readAttribution(kpis)
  const withholdings = orgWithholdings(kpis)
  const scored = readScored(outliers)

  const verdict = readVerdict({
    attribution,
    sources,
    withholdings,
    scored,
    people: { directory: people.directory, inMetrics: people.inMetrics },
  })

  const alerts = sources.flatMap((s) => s.alerts)
  const withheld = withholdings.filter((w) => w.withheld)
  const currentSources = sources.filter((s) => s.level === 'ok').length
  const solidScores = scored.byConfidence.high
  const noMedianCohorts = scored.cohorts.filter((c) => !c.hasMedian)

  // Squads whose score, or one of whose dimensions, was withheld. Same nulls the
  // Outliers table renders as "no data" — counted here rather than re-derived.
  const squadGaps = squads
    .map((squad) => ({
      squad,
      missing: (
        [
          ['Throughput', squad.throughput_score],
          ['Flow', squad.flow_score],
          ['Quality', squad.quality_score],
          ['Collaboration', squad.collaboration_score],
        ] as const
      )
        .filter(([, score]) => score === null)
        .map(([label]) => label),
    }))
    .filter((row) => row.missing.length > 0 || row.squad.score === null)

  const coverageRows: CoverageMeterRow[] = [
    {
      label: 'Merge requests attributed',
      value: attribution.mr,
      floor: 95,
      of: 'of merged merge requests resolve to a known engineer',
      consequence: 'Every per-person and per-squad total is a lower bound, not a total.',
    },
    {
      label: 'Commits attributed',
      value: attribution.commits,
      floor: 95,
      of: 'of commits resolve to a known engineer',
      consequence: 'Per-person churn and commit counts are a lower bound.',
    },
    {
      label: 'Merge requests sized',
      value: scored.orgSizedMrPct,
      floor: COMPLEXITY_COVERAGE_FLOOR,
      of: 'of merged merge requests have a measured size',
      consequence:
        'Throughput counts merge requests raw instead of weighting them by how much they contain.',
    },
    {
      label: 'Period with deploy history',
      value: kpis.deploy_coverage_pct,
      floor: 50,
      of: 'of the period contains production deployments',
      consequence: 'Deploy frequency, change failure rate and time to restore are all withheld.',
    },
    {
      label: 'Issues carrying an estimate',
      value: kpis.story_points_coverage_pct,
      floor: 50,
      of: 'of resolved issues carry a story-point estimate',
      consequence: 'The story-point total is withheld.',
    },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Data trust</h1>
        <p className="text-sm text-[var(--color-muted)]">
          {periodLabel} · what the numbers on the other pages rest on, and where they stop being
          safe to quote
        </p>
      </div>

      {/* --- the verdict, first, because it is what gets quoted ---------------- */}

      <Verdict verdict={verdict} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Work reaching a person"
          value={attribution.worst === null ? 'unknown' : pct(attribution.worst, 1)}
          hint={
            attribution.worst === null
              ? 'Neither attribution figure was measured this period'
              : 'The worse of merge-request and commit attribution'
          }
          direction="higher-better"
          raw={attribution.worst}
          thresholds={{ good: 95, bad: 70 }}
          withheld={attribution.worst === null ? 'nothing was measured — not 0%, not 100%' : undefined}
        />
        <Kpi
          label="Sources current"
          value={`${currentSources} of ${sources.length}`}
          hint="A source with no run in the last day makes a quiet week out of a broken sync"
          direction="higher-better"
          raw={currentSources}
          thresholds={{ good: sources.length, bad: 0 }}
        />
        <Kpi
          label="Org metrics withheld"
          value={`${withheld.length} of ${withholdings.length}`}
          hint="Guarded by sample size or by coverage, and shown as a dash rather than a guess"
          direction="lower-better"
          raw={withheld.length}
          thresholds={{ good: 0, bad: 3 }}
        />
        <Kpi
          label="Scores worth leaning on"
          value={`${solidScores} of ${scored.total}`}
          hint={`The rest have thin data or a cohort under ${MIN_COHORT}`}
          direction="higher-better"
          raw={scored.total > 0 ? solidScores : null}
          thresholds={scored.total > 0 ? { good: scored.total, bad: 0 } : undefined}
          withheld={scored.total === 0 ? 'nobody is scored in this period' : undefined}
        />
      </div>

      {/* --- coverage ---------------------------------------------------------- */}

      <section id="coverage" className="scroll-mt-24">
        <SectionHeading
          title="How much of the work is counted"
          hint="Each bar is a share of a known whole, so the span is the fixed 0-100 and the tick is the floor that share has to clear."
        />
        <Card>
          <CoverageMeters rows={coverageRows} />
        </Card>
        <MetricNote>
          The attribution gap is the one to hold on to, because it is not a random sample. It is
          whichever GitLab and Jira accounts have not been linked to an engineer yet, so it lands
          entirely on whoever those accounts belong to and does not cancel out between squads.
          {attribution.unattributedMrs > 0 ? (
            <>
              {' '}
              {nf(attribution.unattributedMrs)} merged merge{' '}
              {attribution.unattributedMrs === 1 ? 'request counts' : 'requests count'} towards the
              org totals and towards nobody&apos;s personal total.
            </>
          ) : null}{' '}
          A bar drawn hollow has not cleared its floor — same meaning as a hollow dot on the
          Outliers scatter, and deliberately the same single colour, because &quot;not enough&quot;
          is a confidence statement rather than a different kind of thing.
        </MetricNote>

        <div className="mt-4">
          <Table
            empty="Every GitLab and Jira account in the period is linked to an engineer."
            head={
              <>
                <Th>Unlinked accounts</Th>
                <Th align="right">Accounts</Th>
                <Th align="right">Events behind them</Th>
                <Th>Last seen</Th>
              </>
            }
          >
            {(['gitlab', 'jira'] as const)
              .map((provider) => ({
                provider,
                rows: identities.filter((i) => i.provider === provider),
              }))
              .filter((group) => group.rows.length > 0)
              .map((group) => (
                <tr key={group.provider}>
                  <Td className="capitalize">{group.provider}</Td>
                  <Td align="right" numeric>
                    {nf(group.rows.length)}
                  </Td>
                  <Td align="right" numeric>
                    {nf(group.rows.reduce((sum, r) => sum + r.event_count, 0))}
                  </Td>
                  <Td>
                    {relativeDate(
                      group.rows
                        .map((r) => r.last_seen_at)
                        .sort()
                        .at(-1),
                    )}
                  </Td>
                </tr>
              ))}
          </Table>
          <MetricNote>
            These are the accounts the attribution gap is made of.{' '}
            <Link href="/admin" className="underline">
              Linking them on the admin screen
            </Link>{' '}
            is what closes it; nothing on this page can.
          </MetricNote>
        </div>
      </section>

      {/* --- freshness --------------------------------------------------------- */}

      <section id="freshness" className="scroll-mt-24">
        <SectionHeading
          title="Whether the data is current"
          hint="A sync that stops does not make the numbers look wrong. It makes them look like a quiet week."
        />
        <SyncAlertBanner alerts={alerts} />
        <div className={alerts.length > 0 ? 'mt-3' : ''}>
          <Table
            head={
              <>
                <Th>Source</Th>
                <Th>State</Th>
                <Th align="right">Last completed run</Th>
                <Th align="right">Runs seen</Th>
                <Th>What it makes uncertain</Th>
              </>
            }
          >
            {sources.map((source) => (
              <tr key={source.source}>
                <Td className="font-medium capitalize">{source.source}</Td>
                <Td>
                  <SourcePill level={source.level} />
                  {source.running ? (
                    <div className="mt-1 text-[11px] text-[var(--color-muted)]">
                      a run is in flight
                    </div>
                  ) : null}
                </Td>
                <Td align="right" numeric>
                  {source.hoursSinceSuccess === null ? (
                    <span className="text-[var(--color-muted)]">never</span>
                  ) : (
                    <>
                      {hours(source.hoursSinceSuccess)} ago
                      <div className="text-[11px] text-[var(--color-muted)]">
                        {relativeDate(source.lastSuccessAt)}
                      </div>
                    </>
                  )}
                </Td>
                <Td align="right" numeric>
                  {source.observed ? nf(source.finishedRuns) : <span className="text-[var(--color-muted)]">none</span>}
                  {source.consecutivePartial > 0 ? (
                    <div className="text-[11px] text-[var(--color-muted)]">
                      {nf(source.consecutivePartial)} in a row stopped early
                    </div>
                  ) : null}
                </Td>
                <Td className="text-xs text-[var(--color-muted)]">{SOURCE_SCOPE[source.source]}</Td>
              </tr>
            ))}
          </Table>
        </div>
        <MetricNote>
          &quot;Runs seen&quot; counts finished runs only — a run still in flight says nothing about
          health either way. A row that keeps stopping early is the failure worth knowing about,
          because data does keep arriving while it happens: the Jira backfill once spent eight runs
          re-processing the same 560 issues, and every number moved in a believable direction the
          whole time.{' '}
          <Link href="/admin" className="underline">
            Sync history and manual runs
          </Link>
          .
        </MetricNote>
      </section>

      {/* --- what is withheld -------------------------------------------------- */}

      <section id="withheld" className="scroll-mt-24">
        <SectionHeading
          title="What is being withheld, and why"
          hint="Every metric with a guard on it, which side of the guard it fell, and the argument for the guard existing."
        />
        <Table
          head={
            <>
              <Th>Metric</Th>
              <Th>On the page?</Th>
              <Th>Guard</Th>
              <Th>Why the guard is there</Th>
            </>
          }
        >
          {withholdings.map((row) => (
            <tr key={row.metric}>
              <Td className="font-medium">{row.metric}</Td>
              <Td>
                {row.withheld ? (
                  <Pill tone="warn">withheld</Pill>
                ) : (
                  <Pill tone="good">reported</Pill>
                )}
              </Td>
              <Td>
                <GuardSummary guard={row.guard} />
                <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                  {guardWording(row.guard)}
                </div>
              </Td>
              <Td className="max-w-[22rem] text-xs text-[var(--color-muted)]">{row.because}</Td>
            </tr>
          ))}
        </Table>
        <MetricNote>
          Whether a metric is withheld is read from whether the value came back null, not from
          re-applying the floor here — re-applying it is how a page ends up claiming a number is
          available when the RPC withheld it for a reason the page did not model. Two of these sit
          close enough to their floor to flip between periods without anything changing about the
          team, so a metric appearing or disappearing between two visits is not itself a finding.
        </MetricNote>

        <div className="mt-5">
          <SectionHeading
            title="Throughput's unit"
            hint="Which changes on its own as the size backfill advances, so it is worth checking before comparing two periods."
          />
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                Throughput currently counts{' '}
                <strong>
                  {scored.throughputBasis === 'complexity'
                    ? 'complexity-weighted merge requests'
                    : scored.throughputBasis === 'count'
                      ? 'merge requests, unweighted'
                      : 'nothing — no engineer is scored this period'}
                </strong>
                .
              </p>
              <Pill tone={scored.throughputBasis === 'complexity' ? 'good' : 'warn'}>
                {scored.orgSizedMrPct === null ? 'coverage unknown' : `${pct(scored.orgSizedMrPct, 1)} of MRs measured`}
              </Pill>
            </div>
            <MetricNote>
              The basis is chosen once org-wide rather than per engineer, because mixing weighted
              and unweighted merge requests inside one cohort would make that cohort&apos;s median
              meaningless. It flips to weighting on its own above{' '}
              {COMPLEXITY_COVERAGE_FLOOR}% measured — which means a throughput number from before
              the flip and one from after are in different units.{' '}
              <Link href="/outliers" className="underline">
                The rubric is on Outliers
              </Link>
              .
            </MetricNote>
          </Card>
        </div>

        <div className="mt-5">
          <SectionHeading
            title="Squads with a dimension missing"
            hint="A dimension with no data drops out of the score and the remaining weights are renormalised, so a gap never reads as a zero — but it does mean the score covers less."
          />
          <Table
            empty="Every squad has all four dimensions this period."
            head={
              <>
                <Th>Squad</Th>
                <Th align="right">In metrics</Th>
                <Th>Score</Th>
                <Th>Missing</Th>
                <Th>Confidence</Th>
              </>
            }
          >
            {squadGaps.map(({ squad, missing }) => (
              <tr key={squad.squad_id}>
                <Td>
                  <SquadBadge squadKey={squad.squad_key} name={squad.squad_name} />
                </Td>
                <Td align="right" numeric>
                  {nf(squad.headcount)}
                </Td>
                <Td>
                  {squad.score === null ? (
                    <Pill tone="warn">not scored</Pill>
                  ) : (
                    <span className="tnum text-sm">{nf(squad.score, 1)}</span>
                  )}
                </Td>
                <Td className="text-xs">
                  {missing.length > 0 ? missing.join(', ') : <span className="text-[var(--color-muted)]">—</span>}
                </Td>
                <Td className="max-w-[18rem] text-xs text-[var(--color-muted)]">
                  {squad.confidence_reason ?? 'No caveat recorded'}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      </section>

      {/* --- cohorts ----------------------------------------------------------- */}

      <section id="cohorts" className="scroll-mt-24">
        <SectionHeading
          title="Whether there is a cohort to compare against"
          hint={`An engineer's score is measured against the median of their own seniority level. Below ${MIN_COHORT} people there is no median for it to be the middle of.`}
        />
        <Table
          empty="Nobody is scored in this period."
          head={
            <>
              <Th>Level</Th>
              <Th align="right">People at level</Th>
              <Th>Has a median?</Th>
              <Th>Scores to discount</Th>
            </>
          }
        >
          {scored.cohorts.map((cohort) => (
            <tr key={cohort.key}>
              <Td className="font-medium">{cohort.label}</Td>
              <Td align="right" numeric>
                {nf(cohort.people)}
              </Td>
              <Td>
                {cohort.hasMedian ? (
                  <Pill tone="good">yes</Pill>
                ) : (
                  <Pill tone="warn">no median</Pill>
                )}
              </Td>
              <Td className="text-xs text-[var(--color-muted)]">
                {cohort.thin === 0 && cohort.noCohort === 0
                  ? 'None — every score here rests on enough work'
                  : [
                      cohort.thin > 0 ? `${nf(cohort.thin)} on thin data` : null,
                      cohort.noCohort > 0 ? `${nf(cohort.noCohort)} with no cohort` : null,
                    ]
                      .filter(Boolean)
                      .join(', ')}
              </Td>
            </tr>
          ))}
        </Table>
        <MetricNote>
          {noMedianCohorts.length === 0 ? (
            <>
              No level is under {MIN_COHORT} people this period, so every score on Outliers has a
              real cohort median behind it. That is a fact about today rather than a property of the
              tool — one leaver from a level of three turns its whole row into an engineer measured
              against themselves, and this is the row that would say so.
            </>
          ) : (
            <>
              {noMedianCohorts.length === 1 ? 'One level is' : `${noMedianCohorts.length} levels are`}{' '}
              under {MIN_COHORT} people ({noMedianCohorts.map((c) => c.label).join(', ')}), so a
              score there is measured against almost nobody but the person themselves. Treat those
              rows on Outliers as descriptive and nothing more.
            </>
          )}{' '}
          Separately, {scored.byConfidence.thin === 0 ? 'no engineer has' : `${nf(scored.byConfidence.thin)} ${scored.byConfidence.thin === 1 ? 'engineer has' : 'engineers have'}`}{' '}
          too little work in the window for their score to mean much — the score is still produced,
          because suppressing it would hide the person entirely, and{' '}
          <Link href="/outliers" className="underline">
            the confidence column on Outliers
          </Link>{' '}
          carries the reason on the row itself.
        </MetricNote>
      </section>

      {/* --- who the numbers are about ----------------------------------------- */}

      <section id="people" className="scroll-mt-24">
        <SectionHeading
          title="Who the numbers are about"
          hint="The denominator behind every per-engineer rate on the site. It is not the size of the engineering department."
        />
        <Table
          head={
            <>
              <Th>Group</Th>
              <Th align="right">People</Th>
              <Th>Effect on the numbers</Th>
            </>
          }
        >
          <tr>
            <Td className="font-medium">Counted in metrics</Td>
            <Td align="right" numeric>
              {nf(people.inMetrics)}
            </Td>
            <Td className="text-xs text-[var(--color-muted)]">
              Every per-engineer rate divides by this number.
            </Td>
          </tr>
          <tr>
            <Td>Active, held out of metrics</Td>
            <Td align="right" numeric>
              {nf(people.excluded)}
            </Td>
            <Td className="text-xs text-[var(--color-muted)]">
              Managers and leadership by default, so a per-engineer rate is not diluted by people
              whose job is not shipping merge requests. Their own work still counts towards org
              totals.
            </Td>
          </tr>
          <tr>
            <Td>Former employees</Td>
            <Td align="right" numeric>
              {nf(people.former)}
            </Td>
            <Td className="text-xs text-[var(--color-muted)]">
              Out of the headcount, but work they did inside the window is still in the org totals —
              which is why a squad total can exceed what its current members did.
            </Td>
          </tr>
          <tr>
            <Td>Ignored</Td>
            <Td align="right" numeric>
              {nf(people.ignored)}
            </Td>
            <Td className="text-xs text-[var(--color-muted)]">
              Taken out of the product altogether: not a head, not a cohort member, and nothing they
              authored or reviewed counts anywhere.
            </Td>
          </tr>
          <tr>
            <Td className="font-medium">In the directory</Td>
            <Td align="right" numeric>
              {nf(people.directory)}
            </Td>
            <Td className="text-xs text-[var(--color-muted)]">
              Everyone HiBob knows about, including all of the above.
            </Td>
          </tr>
        </Table>
        <MetricNote>
          The gap between {nf(people.inMetrics)} and {nf(people.directory)} is the single most common
          way a number here gets misquoted: &quot;{nf(kpis.mrs_per_engineer_week, 2)} merge requests
          per engineer per week&quot; is per <em>engineer counted in metrics</em>, and dividing the
          same work by {nf(people.directory)} would give a figure less than a third as large. Both
          are true sentences about different denominators, which is exactly why the denominator
          belongs next to the rate.{' '}
          <Link href="/admin" className="underline">
            Who is in which group
          </Link>{' '}
          is set on the admin screen.
        </MetricNote>
      </section>

      <p className="text-xs text-[var(--color-muted)]">
        Nothing on this page is a new measurement. Each figure is read through the same helper the
        banner that states it uses, so a disagreement between this page and a banner would be a bug
        rather than a second opinion. The thresholds and the reasoning behind them are in{' '}
        <Link href="/performance" className="underline">
          the measurement framework
        </Link>
        .
      </p>
    </div>
  )
}

/** What each source is the only witness for, so a stale row has a consequence. */
const SOURCE_SCOPE: Record<string, string> = {
  gitlab: 'Merge requests, reviews, commits, deploys — so every delivery and quality metric.',
  jira: 'Issues, sprints, estimates and work type.',
  hibob: 'Headcount, seniority, squad membership and leavers — the denominators.',
}

/**
 * The verdict, and the clauses that produced it.
 *
 * Tone is carried by the border rather than by the text, because the headline has to
 * survive being read on its own — someone will paste this sentence into Slack, and it
 * has to be true without the colour.
 */
function Verdict({ verdict }: { verdict: TrustVerdict }) {
  const tone =
    verdict.level === 'blocked'
      ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
      : verdict.level === 'caveated'
        ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
        : 'border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30'

  return (
    <Card className={tone}>
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
        Before you quote any of this to another human
      </p>
      <p className="mt-1.5 text-base font-semibold leading-relaxed">{verdict.headline}</p>
      {verdict.clauses.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {verdict.clauses.map((clause) => (
            <ClauseRow key={clause.text} clause={clause} />
          ))}
        </ul>
      ) : null}
      {verdict.notes.length > 0 ? (
        <div className="mt-4 border-t border-[var(--color-line)] pt-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
            True every day, not a problem with today
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {verdict.notes.map((note) => (
              <ClauseRow key={note.text} clause={note} />
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}

function ClauseRow({ clause }: { clause: TrustClause }) {
  return (
    <li className="flex items-baseline gap-2 text-xs leading-relaxed">
      <span className="shrink-0">
        <Pill tone={clause.level === 'bad' ? 'bad' : 'warn'}>
          {clause.level === 'bad' ? 'blocker' : clause.level === 'unknown' ? 'unknown' : 'caveat'}
        </Pill>
      </span>
      <span>
        {clause.text}
        {' — '}
        <Link href={`#${clause.section}`} className="underline">
          see the working
        </Link>
      </span>
    </li>
  )
}

/** Freshness only. A source is current, behind, broken, or has never been seen. */
function SourcePill({ level }: { level: TrustLevel }) {
  if (level === 'ok') return <Pill tone="good">current</Pill>
  if (level === 'bad') return <Pill tone="bad">broken</Pill>
  if (level === 'unknown') return <Pill tone="warn">never run</Pill>
  return <Pill tone="warn">behind</Pill>
}

/** Whether a guard cleared, said in words next to the count it cleared by. */
function guardWording(guard: Guard): string {
  const level = guardLevel(guard)
  if (guard.kind === 'coverage') {
    if (guard.pct === null) return 'coverage was never measured'
    return level === 'ok'
      ? `clears by ${(guard.pct - guard.floor).toFixed(1)} points`
      : `short by ${(guard.floor - guard.pct).toFixed(1)} points`
  }
  return level === 'ok'
    ? `${nf(guard.n - guard.floor)} above the floor`
    : `${nf(guard.floor - guard.n)} short of the floor`
}
