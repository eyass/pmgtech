import Link from 'next/link'

import { BandPill, ShapePill } from '@/components/performance'
import { Card, MetricNote, Pill, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { hours, nf, pct } from '@/lib/format'
import {
  getEngineerOutliers,
  getSquadOutliers,
  getSquads,
  PERIODS,
  resolvePeriod,
} from '@/lib/queries'
import {
  COMPLEXITY_COVERAGE_FLOOR,
  COMPLEXITY_RUBRIC,
  ENGINEER_SCORE_RUBRIC,
  scoreTone,
  SQUAD_SCORE_RUBRIC,
  type EngineerOutlier,
  type ScoreConfidence,
  type SquadOutlier,
  type Standing,
} from '@/lib/types/performance'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Outliers — PMG Engineering Tracker' }

/**
 * Scored rankings for engineers and squads: who is top, who is bottom.
 *
 * The score is a real composite and it is meant to be sorted on. What keeps it
 * defensible is what surrounds it: engineers are scored against their own level
 * cohort rather than the org, squads against absolute targets rather than each
 * other, every sub-score is on the page next to the total, and the materiality
 * tally from the banding logic sits beside each engineer's score to say whether
 * the gap that produced their rank is large enough to be real.
 */
export default async function OutliersPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; squad?: string }>
}) {
  const { period, squad: squadFilter } = await searchParams
  const { key, range } = resolvePeriod(period)

  const squads = await getSquads()
  const selected = squadFilter ? squads.find((s) => s.key === squadFilter) : undefined

  const [engineers, squadRows] = await Promise.all([
    getEngineerOutliers(range, selected?.id),
    getSquadOutliers(range),
  ])

  const scored = engineers.filter((e) => e.score !== null)
  const bestSquad = squadRows[0]
  const worstSquad = squadRows[squadRows.length - 1]
  const best = scored[0]
  const worst = scored[scored.length - 1]

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Outliers</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {PERIODS[key].label}
            {selected ? ` · ${selected.name}` : ''} · {scored.length} engineers and{' '}
            {squadRows.length} squads scored
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <FilterLink period={key} squad={undefined} active={!selected} label="All squads" />
          {squads
            .filter((s) => s.is_active)
            .map((s) => (
              <FilterLink
                key={s.key}
                period={key}
                squad={s.key}
                active={selected?.key === s.key}
                label={s.name}
              />
            ))}
        </div>
      </div>

      {/* --- the four headlines ----------------------------------------------- */}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HeadlineCard
          label="Top squad"
          name={bestSquad?.squad_name}
          score={bestSquad?.score}
          detail={bestSquad ? `against targets · ${nf(bestSquad.headcount)} in metrics` : undefined}
        />
        <HeadlineCard
          label="Bottom squad"
          name={worstSquad?.squad_name}
          score={worstSquad?.score}
          detail={
            worstSquad ? `against targets · ${nf(worstSquad.headcount)} in metrics` : undefined
          }
        />
        <HeadlineCard
          label="Top engineer"
          name={best?.full_name}
          score={best?.score}
          detail={best ? `vs ${best.peers_at_level} at ${best.seniority_label ?? best.seniority_key}` : undefined}
        />
        <HeadlineCard
          label="Bottom engineer"
          name={worst?.full_name}
          score={worst?.score}
          detail={
            worst ? `vs ${worst.peers_at_level} at ${worst.seniority_label ?? worst.seniority_key}` : undefined
          }
        />
      </div>

      {/* --- what throughput is counting in ----------------------------------- */}

      <ComplexityBanner rows={engineers} />

      {/* --- how the score works ---------------------------------------------- */}

      <Card>
        <h2 className="text-sm font-semibold">How the score is built</h2>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-sm font-medium">Engineers — 0-100 against their own level</p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-muted)]">
              Four dimensions, weighted equally at 25 each, every one measured against the median of
              the engineer&apos;s <em>own seniority cohort</em>. <strong>50 is that median</strong>,
              not half marks, and one interquartile range of the cohort&apos;s own spread is worth 15
              points. A junior is never scored against a staff engineer.
            </p>
            <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-muted)]">
              {Object.entries(ENGINEER_SCORE_RUBRIC).map(([dimension, inputs]) => (
                <li key={dimension}>
                  <span className="font-medium capitalize">{dimension}</span> — {inputs}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-medium">Squads — 0-100 against absolute targets</p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-muted)]">
              The same four dimensions and the same equal weights, but each metric is scored between
              a <em>bad</em> and a <em>good</em> threshold rather than against the other squads. A
              squad is only bottom if it is actually missing the targets, and a strong org does not
              manufacture a loser.
            </p>
            <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-muted)]">
              {Object.values(SQUAD_SCORE_RUBRIC).flatMap((dimension) =>
                dimension.metrics.map((metric) => (
                  <li key={metric.key}>
                    <span className="font-medium">{metric.label}</span> — {metric.bad} is 0,{' '}
                    {metric.good} is 100
                  </li>
                )),
              )}
            </ul>
          </div>
        </div>
        <MetricNote>
          Two guards travel with every score. A dimension with no data drops out and the remaining
          weights are renormalised, so a missing input never reads as a zero. And every row carries a{' '}
          <strong>confidence</strong> flag: a score built on two merged merge requests, or against a
          cohort of one, is shown with a warning rather than quietly ranked. On the engineer table the{' '}
          <strong>gap</strong> column is the honest check on precision — it only reads{' '}
          <em>above</em> or <em>below</em> when a dimension clears the materiality gates (25% on cycle
          time, 10 points on coverage, two reviews and 25% on reviews given), so two scores a point
          apart both read <em>even</em>, because they are the same score.
        </MetricNote>
      </Card>

      {/* --- squads ----------------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Squads, ranked"
          hint="Scored against absolute targets. Empty placeholder squads are excluded rather than ranked last."
        />
        <Table
          empty="No squad has enough data in this period."
          head={
            <>
              <Th>#</Th>
              <Th>Squad</Th>
              <Th align="right">Score</Th>
              <Th align="right">Throughput</Th>
              <Th align="right">Flow</Th>
              <Th align="right">Quality</Th>
              <Th align="right">Collaboration</Th>
              <Th>Confidence</Th>
            </>
          }
        >
          {squadRows.map((squad) => (
            <tr key={squad.squad_id}>
              <Td numeric className="text-xs text-[var(--color-muted)]">{squad.rank_in_org}</Td>
              <Td>
                <Link href={`/squads/${squad.squad_key}`} className="hover:underline">
                  <SquadBadge squadKey={squad.squad_key} name={squad.squad_name} />
                </Link>
                <div className="mt-1 text-xs text-[var(--color-muted)]">
                  {nf(squad.headcount)} in metrics
                </div>
              </Td>
              <Td align="right">
                <ScorePill score={squad.score} />
              </Td>
              <SubScore
                score={squad.throughput_score}
                lines={[
                  squad.throughput_basis === 'complexity'
                    ? `${nf(squad.effective_mrs_per_engineer_week, 2)} weighted MRs/eng/wk`
                    : `${nf(squad.mrs_per_engineer_week, 2)} MRs/eng/wk`,
                  `${nf(squad.deploys_per_week, 2)} releases/wk`,
                  ...(squad.throughput_basis === 'complexity' && squad.points_per_mr !== null
                    ? [`${nf(squad.points_per_mr, 2)} per MR`]
                    : []),
                ]}
              />
              <SubScore score={squad.flow_score} lines={[`${hours(squad.median_cycle_hours)} cycle`]} />
              <SubScore
                score={squad.quality_score}
                lines={[
                  `${pct(squad.change_failure_pct, 1)} change failure`,
                  `${hours(squad.mttr_hours)} to restore`,
                ]}
              />
              <SubScore
                score={squad.collaboration_score}
                lines={[
                  `${pct(squad.review_coverage_pct, 1)} coverage`,
                  `${nf(squad.reviews_per_engineer_week, 2)} reviews/eng/wk`,
                ]}
              />
              <Td>
                <ConfidencePill confidence={squad.score_confidence} />
                {squad.confidence_reason ? (
                  <div className="mt-1 max-w-[16rem] text-[11px] text-[var(--color-muted)]">
                    {squad.confidence_reason}
                  </div>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
        <MetricNote>
          Scores bunch at the top here because every squad comfortably clears most of the thresholds
          — which is the useful finding, and the reason a two-point gap between first and second is
          not a story. Look at the sub-scores instead: they are where the squads actually differ, and
          a dimension reading <em>no data</em> means the sample behind it was withheld rather than
          bad. {worstSquad?.squad_name ?? 'The bottom squad'} is last on{' '}
          {worstSquad && worstSquad.throughput_score !== null && worstSquad.throughput_score < 70
            ? 'throughput'
            : 'the balance of the four'}
          , not on everything.
        </MetricNote>
      </section>

      {/* --- engineers -------------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Engineers, ranked"
          hint="Scored against their own seniority cohort. Rank within level is shown next to rank in the org, because the cohort is what the score is measured against."
        />
        <EngineerTable rows={engineers} />
        <MetricNote>
          The spread is narrow on purpose: 15 points is a full interquartile range of the
          cohort&apos;s own distribution, so a group of engineers doing similar work lands in a tight
          band, and the ranking within that band is ordering, not distance.{' '}
          {scored.length > 1 && best?.score != null && worst?.score != null ? (
            <>
              First to last here is {nf(best.score - worst.score, 1)} points across{' '}
              {scored.length} people.{' '}
            </>
          ) : null}
          What this cannot see is unchanged by being scored: design work, incident response,
          pairing, on-call, mentoring, and anything shipped outside GitLab and Jira. A low score is a
          prompt to go and ask, and the answer is often that the work was real and invisible here.
        </MetricNote>
      </section>

      <p className="text-xs text-[var(--color-muted)]">
        Thresholds, weights and the reasoning behind each one are in{' '}
        <Link href="/performance" className="underline">
          the measurement framework
        </Link>
        .
      </p>
    </div>
  )
}

/**
 * What the throughput dimension is actually counting, and why.
 *
 * This is on the page rather than in the docs because the answer changes by itself:
 * throughput counts complexity-weighted merge requests once enough of them have a
 * measured size, and raw merge requests until then. A reader comparing two periods
 * needs to know which unit they are looking at, and someone reading it the week the
 * backfill is still running needs to know the weighting is not live yet.
 */
function ComplexityBanner({ rows }: { rows: EngineerOutlier[] }) {
  const first = rows[0]
  if (!first) return null
  const weighted = first.throughput_basis === 'complexity'
  const coverage = first.org_sized_mr_pct ?? 0

  return (
    <Card
      className={
        weighted
          ? undefined
          : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Throughput counts {weighted ? 'complexity-weighted merge requests' : 'merge requests'}
        </h2>
        <Pill tone={weighted ? 'good' : 'warn'}>{pct(coverage, 1)} of MRs measured</Pill>
      </div>
      {weighted ? (
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--color-muted)]">
          A merge request is worth <strong>{COMPLEXITY_RUBRIC.unit.toLowerCase()}</strong>:{' '}
          <code className="rounded bg-[var(--color-line)] px-1 py-0.5 text-xs">
            {COMPLEXITY_RUBRIC.formula}
          </code>
          . {COMPLEXITY_RUBRIC.trivialFloor}, so twenty of those are worth two median ones rather
          than twenty. {COMPLEXITY_RUBRIC.cap}, because rewarding lines linearly would just move
          the gaming from many-small to one-enormous — and large changes are harder to review.
        </p>
      ) : (
        <p className="mt-2 max-w-3xl text-sm leading-relaxed">
          <strong>The weighting is not live yet.</strong> Merge-request sizes were never collected
          — the sync read a GitLab field that does not exist and stored zero for all 2,000 merge
          requests — so only {pct(coverage, 1)} of this period&apos;s work has a measured size,
          below the {COMPLEXITY_COVERAGE_FLOOR}% needed. Throughput therefore still counts merge
          requests, exactly as it did before, and switches to weighted units on its own once the
          sync&apos;s size backfill has worked through history. Mixing the two units inside one
          cohort would make its median meaningless, so the basis is chosen once for everybody.
        </p>
      )}
      <MetricNote>{COMPLEXITY_RUBRIC.blindSpot}</MetricNote>
    </Card>
  )
}

function HeadlineCard({
  label,
  name,
  score,
  detail,
}: {
  label: string
  name: string | undefined
  score: number | null | undefined
  detail: string | undefined
}) {
  return (
    <Card>
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
      {name ? (
        <>
          <p className="mt-1 truncate text-sm font-semibold" title={name}>
            {name}
          </p>
          <p className="tnum mt-1 text-2xl font-semibold">{nf(score, 1)}</p>
          <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">{detail}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-[var(--color-muted)]">Nothing scored this period</p>
      )}
    </Card>
  )
}

function ScorePill({ score }: { score: number | null }) {
  const tone = scoreTone(score)
  return (
    <span className="tnum">
      <Pill tone={tone}>{score === null ? 'no score' : nf(score, 1)}</Pill>
    </span>
  )
}

/** A dimension's sub-score with the inputs that produced it underneath. */
function SubScore({ score, lines }: { score: number | null; lines: string[] }) {
  const tone = scoreTone(score)
  const colour =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'bad'
        ? 'text-red-600 dark:text-red-400'
        : tone === 'warn'
          ? 'text-amber-600 dark:text-amber-400'
          : ''
  return (
    <Td align="right" numeric>
      <span className={`font-medium ${colour}`}>{score === null ? 'no data' : nf(score, 1)}</span>
      {score === null ? null : (
        <div className="text-[11px] text-[var(--color-muted)]">
          {lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
    </Td>
  )
}

/**
 * Weighted merge requests against the raw count — the cell where splitting work into
 * tiny pieces becomes visible. A ratio near 1.0 means their changes are about the
 * org's median size; 0.1 means they are at the trivial floor.
 */
function ComplexityCell({ engineer }: { engineer: EngineerOutlier }) {
  if (engineer.effective_mrs === null) {
    return (
      <Td align="right" numeric>
        <span className="text-[var(--color-muted)]" title="No merge request of theirs has a measured size yet">
          not measured
        </span>
        <div className="text-[11px] text-[var(--color-muted)]">{nf(engineer.merged_mrs)} MRs</div>
      </Td>
    )
  }
  const ratio = engineer.points_per_mr
  // Amber below half a median MR: not a verdict, but the number to ask about.
  const tone =
    ratio !== null && ratio < 0.5
      ? 'text-amber-600 dark:text-amber-400'
      : ratio !== null && ratio >= 1.5
        ? 'text-emerald-600 dark:text-emerald-400'
        : ''
  return (
    <Td align="right" numeric>
      <span className={`font-medium ${tone}`}>{nf(engineer.effective_mrs, 1)}</span>
      <div className="text-[11px] text-[var(--color-muted)]">
        <div>
          {nf(ratio, 2)} / MR · {nf(engineer.median_churn)} lines
        </div>
        {engineer.trivial_mr_pct !== null && engineer.trivial_mr_pct > 0 ? (
          <div title="Merge requests of 10 lines or fewer touching a single file">
            {pct(engineer.trivial_mr_pct, 0)} trivial
          </div>
        ) : null}
        {engineer.sized_mr_pct !== null && engineer.sized_mr_pct < 100 ? (
          <div title="The rest have no measured size yet, so this total is an understatement">
            {pct(engineer.sized_mr_pct, 0)} measured
          </div>
        ) : null}
      </div>
    </Td>
  )
}

function ConfidencePill({ confidence }: { confidence: ScoreConfidence }) {
  if (confidence === 'high') return <Pill tone="good">solid</Pill>
  if (confidence === 'thin') return <Pill tone="warn">thin data</Pill>
  return <Pill tone="warn">no cohort</Pill>
}

/**
 * Whether the score's gap from the cohort is material. Kept next to the score so
 * the ranking cannot be read as more precise than it is.
 */
function GapPill({ standing, net }: { standing: Standing; net: number }) {
  if (standing === 'top') return <Pill tone="good">+{net} real</Pill>
  if (standing === 'bottom') return <Pill tone="warn">{net} real</Pill>
  if (standing === 'unread') return <Pill tone="neutral">no read</Pill>
  return <Pill tone="neutral">even</Pill>
}

function EngineerTable({ rows }: { rows: EngineerOutlier[] }) {
  return (
    <Table
      empty="No engineer has enough data in this period."
      head={
        <>
          <Th>#</Th>
          <Th>Engineer</Th>
          <Th>Level</Th>
          <Th>Squad</Th>
          <Th align="right">Score</Th>
          <Th align="right" title="Dimensions materially apart from the cohort median. 'even' means the score gap is inside the noise.">
            Gap
          </Th>
          <Th align="right">Throughput</Th>
          <Th align="right" title="Merge requests weighted by how much each one contained, in units of the org's median merged MR. Well below the raw count means their changes are small.">
            Weighted MRs
          </Th>
          <Th align="right">Flow</Th>
          <Th align="right">Quality</Th>
          <Th align="right">Collaboration</Th>
          <Th>Shape</Th>
          <Th>Confidence</Th>
        </>
      }
    >
      {rows.map((engineer) => (
        <tr key={engineer.engineer_id}>
          <Td numeric className="text-xs text-[var(--color-muted)]">{engineer.rank_in_org}</Td>
          <Td>
            <Link href={`/people/${engineer.engineer_id}`} className="hover:underline">
              {engineer.full_name}
            </Link>
            <div className="text-xs text-[var(--color-muted)]">{engineer.job_title ?? '—'}</div>
          </Td>
          <Td className="text-xs">
            {engineer.seniority_label ?? engineer.seniority_key}
            <div className="text-[11px] text-[var(--color-muted)]">
              #{engineer.rank_at_level} of {engineer.peers_at_level} at level
            </div>
          </Td>
          <Td>
            <SquadBadge squadKey={engineer.squad_key} name={engineer.squad_name ?? 'Unassigned'} />
          </Td>
          <Td align="right">
            <ScorePill score={engineer.score} />
          </Td>
          <Td align="right">
            <GapPill standing={engineer.standing} net={engineer.net} />
          </Td>
          <SubScore
            score={engineer.throughput_score}
            lines={[`${nf(engineer.merged_mrs)} MRs`, `${nf(engineer.issues_resolved)} issues`]}
          />
          <ComplexityCell engineer={engineer} />
          <SubScore
            score={engineer.flow_score}
            lines={[hours(engineer.median_cycle_hours)]}
          />
          <SubScore
            score={engineer.quality_score}
            lines={[
              `${pct(engineer.review_coverage_received_pct, 0)} reviewed`,
              `${nf(engineer.reverts_authored)} reverts`,
            ]}
          />
          <SubScore
            score={engineer.collaboration_score}
            lines={[
              `${nf(engineer.reviews_given)} reviews`,
              `${nf(engineer.distinct_authors_reviewed)} colleagues`,
            ]}
          />
          <Td>
            <div className="flex flex-col items-start gap-1">
              <ShapePill shape={engineer.shape} />
              <div className="flex gap-1">
                <BandPill band={engineer.flow_band} />
                <BandPill band={engineer.quality_band} />
                <BandPill band={engineer.collaboration_band} />
              </div>
            </div>
          </Td>
          <Td>
            <ConfidencePill confidence={engineer.score_confidence} />
            {engineer.confidence_reason ? (
              <div className="mt-1 max-w-[16rem] text-[11px] text-[var(--color-muted)]">
                {engineer.confidence_reason}
              </div>
            ) : null}
          </Td>
        </tr>
      ))}
    </Table>
  )
}

function FilterLink({
  period,
  squad,
  active,
  label,
}: {
  period: string
  squad: string | undefined
  active: boolean
  label: string
}) {
  const query = new URLSearchParams({ period })
  if (squad) query.set('squad', squad)
  return (
    <Link
      href={`/outliers?${query.toString()}`}
      className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
          : 'border-[var(--color-line)] text-[var(--color-muted)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
    </Link>
  )
}
