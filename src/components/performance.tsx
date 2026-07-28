import type { ReactNode } from 'react'

import { Card, Pill } from '@/components/ui'
import { hours, nf, pct } from '@/lib/format'
import {
  BAND_LABEL,
  SHAPE_MEANING,
  TEAM_TARGETS,
  type Band,
  type EngineerProfile,
  type Shape,
  type TeamHealth,
} from '@/lib/types/performance'

/** Rate a team metric against its target. Teams only — never people. */
export function rateTeamMetric(
  metric: keyof typeof TEAM_TARGETS,
  value: number | null | undefined,
): 'good' | 'warn' | 'bad' | 'neutral' {
  if (value === null || value === undefined) return 'neutral'
  const t = TEAM_TARGETS[metric]
  if (t.direction === 'higher-better') {
    if (value >= t.good) return 'good'
    if (value <= t.bad) return 'bad'
    return 'warn'
  }
  if (value <= t.good) return 'good'
  if (value >= t.bad) return 'bad'
  return 'warn'
}

const TONE_TEXT = {
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
  neutral: 'text-[var(--color-muted)]',
} as const

/** One metric inside a dimension block, rated against its team target. */
export function TeamMetric({
  label,
  value,
  metric,
  raw,
  hint,
}: {
  label: string
  value: string
  metric?: keyof typeof TEAM_TARGETS
  raw?: number | null
  hint?: string
}) {
  const tone = metric ? rateTeamMetric(metric, raw) : 'neutral'
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-line)] py-1.5 last:border-0">
      <span className="text-xs text-[var(--color-muted)]" title={hint}>
        {label}
      </span>
      <span className={`tnum text-sm font-medium ${metric ? TONE_TEXT[tone] : ''}`}>{value}</span>
    </div>
  )
}

export function DimensionCard({
  name,
  question,
  children,
  footnote,
}: {
  name: string
  question: string
  children: ReactNode
  footnote?: string
}) {
  return (
    <Card>
      <h3 className="text-sm font-semibold">{name}</h3>
      <p className="mt-0.5 text-xs italic text-[var(--color-muted)]">{question}</p>
      <div className="mt-3">{children}</div>
      {footnote ? (
        <p className="mt-3 border-t border-[var(--color-line)] pt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
          {footnote}
        </p>
      ) : null}
    </Card>
  )
}

/** All four dimensions for one squad. */
export function TeamDimensions({ team }: { team: TeamHealth }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
      <DimensionCard
        name="Flow"
        question="Does work move, or does it queue?"
        footnote="Flow efficiency is working time over elapsed time. Below 15% means the team spends most of its time waiting — on review, CI, or another team — which is a system problem, not an effort problem."
      >
        <TeamMetric label="Lead time (median)" value={hours(team.median_cycle_hours)} metric="median_cycle_hours" raw={team.median_cycle_hours} />
        <TeamMetric label="Lead time (p75)" value={hours(team.p75_cycle_hours)} />
        <TeamMetric label="Flow efficiency" value={pct(team.flow_efficiency_pct, 1)} metric="flow_efficiency_pct" raw={team.flow_efficiency_pct} />
        <TeamMetric label="Deploys / week" value={nf(team.deploys_per_week, 1)} metric="deploys_per_week" raw={team.deploys_per_week} />
        <TeamMetric label="Batch size (median MR)" value={nf(team.median_mr_churn)} hint="Lines changed. Large batches slow review and raise defect risk." />
        <TeamMetric label="WIP per engineer" value={nf(team.wip_per_engineer, 2)} hint="Open merge requests divided by headcount." />
      </DimensionCard>

      <DimensionCard
        name="Quality"
        question="Does what we ship stay working?"
        footnote="Change failure rate counts only deployments that finished, so an in-flight deploy is never assumed successful. A squad doing the hardest work will read worse here than one doing routine work."
      >
        <TeamMetric label="Change failure rate" value={pct(team.change_failure_pct, 1)} metric="change_failure_pct" raw={team.change_failure_pct} />
        <TeamMetric label="Time to restore" value={hours(team.mttr_hours)} metric="mttr_hours" raw={team.mttr_hours} />
        <TeamMetric label="Review coverage" value={pct(team.review_coverage_pct, 1)} metric="review_coverage_pct" raw={team.review_coverage_pct} />
        <TeamMetric label="Reverts" value={nf(team.reverts)} hint="Commits whose message starts with 'revert'. A prompt to look, not a verdict." />
        <TeamMetric label="Production bugs" value={nf(team.production_bugs)} hint="Bug or incident tickets labelled or prioritised as production-affecting." />
      </DimensionCard>

      <DimensionCard
        name="Collaboration"
        question="Is knowledge shared, or concentrated?"
        footnote="Review load Gini runs 0 (evenly shared) to 1 (one person carries everything). Above 0.6 usually means one or two people are the review bottleneck and a single point of failure."
      >
        <TeamMetric label="Reviews per eng / week" value={nf(team.reviews_per_engineer_week, 2)} />
        <TeamMetric label="Review load Gini" value={team.review_gini === null ? '—' : nf(team.review_gini, 3)} metric="review_gini" raw={team.review_gini} />
        <TeamMetric label="Cross-squad reviews" value={pct(team.cross_squad_review_pct, 1)} metric="cross_squad_review_pct" raw={team.cross_squad_review_pct} />
        <TeamMetric label="Review response (median)" value={hours(team.median_review_response_hours)} metric="median_review_response_hours" raw={team.median_review_response_hours} />
        <TeamMetric label="Review depth (median)" value={team.median_review_depth_chars === null ? '—' : `${nf(team.median_review_depth_chars)} chars`} hint="Median comment length. Very low values suggest rubber-stamping rather than review." />
      </DimensionCard>

      <DimensionCard
        name="Impact"
        question="Was the work worth building?"
        footnote="Context only. Telemetry cannot see business value or judgement. Treat these as inputs to a conversation about direction, not as a score."
      >
        <TeamMetric label="Unplanned work" value={pct(team.unplanned_work_pct, 1)} metric="unplanned_work_pct" raw={team.unplanned_work_pct} />
        <TeamMetric label="Sprint completion" value={pct(team.sprint_completion_pct, 1)} metric="sprint_completion_pct" raw={team.sprint_completion_pct} />
        <TeamMetric label="Issues resolved" value={nf(team.issues_resolved)} />
        <TeamMetric label="Story points" value={nf(team.story_points)} />
      </DimensionCard>
    </div>
  )
}

const BAND_TONE: Record<Band, 'good' | 'warn' | 'bad' | 'neutral'> = {
  above: 'good',
  typical: 'neutral',
  below: 'warn',
  insufficient: 'neutral',
}

export function BandPill({ band }: { band: Band }) {
  const tone = BAND_TONE[band]
  return (
    <Pill tone={tone === 'good' ? 'good' : tone === 'warn' ? 'warn' : 'neutral'}>
      {band === 'insufficient' ? 'no read' : band}
    </Pill>
  )
}

export function ShapePill({ shape }: { shape: Shape }) {
  return (
    <span title={SHAPE_MEANING[shape]}>
      <Pill tone={shape === 'Quiet in telemetry' ? 'neutral' : 'good'}>{shape}</Pill>
    </span>
  )
}

/**
 * An individual's profile across the three telemetry-visible dimensions.
 * Deliberately shows the shape rather than a score: "reviews a lot, ships less"
 * is information that a composite number would destroy.
 */
export function IndividualProfile({ profile }: { profile: EngineerProfile }) {
  const noRead = !profile.sample_sufficient || profile.peers_at_level < 3

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ShapePill shape={profile.shape} />
        <span className="text-xs text-[var(--color-muted)]">
          Compared against {profile.peers_at_level}{' '}
          {profile.peers_at_level === 1 ? 'person' : 'people'} at{' '}
          {profile.seniority_label ?? profile.seniority_key}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-[var(--color-muted)]">
        {SHAPE_MEANING[profile.shape]}
      </p>

      {noRead ? (
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-xs leading-relaxed">
            <strong>No comparative read available.</strong>{' '}
            {!profile.sample_sufficient
              ? `Fewer than 5 merged merge requests and fewer than 5 resolved issues in this period — too little to say anything.`
              : `Only ${profile.peers_at_level} ${profile.peers_at_level === 1 ? 'person' : 'people'} at this level, so a within-level comparison would single someone out.`}{' '}
            The raw counts below are still shown as conversation material.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <DimensionCard name="Flow" question="Is their work getting stuck?">
          <div className="mb-2">
            <BandPill band={profile.flow_band} />
            <span className="ml-2 text-[11px] text-[var(--color-muted)]">
              {BAND_LABEL[profile.flow_band]}
            </span>
          </div>
          <TeamMetric label="Cycle time (median)" value={hours(profile.median_cycle_hours)} />
          <TeamMetric label="Flow efficiency" value={pct(profile.flow_efficiency_pct, 1)} />
          <TeamMetric label="MR size (median)" value={nf(profile.median_mr_churn)} />
          <TeamMetric label="Open MRs now" value={nf(profile.open_mrs)} />
        </DimensionCard>

        <DimensionCard name="Quality" question="Are they shipping safely?">
          <div className="mb-2">
            <BandPill band={profile.quality_band} />
            <span className="ml-2 text-[11px] text-[var(--color-muted)]">
              {BAND_LABEL[profile.quality_band]}
            </span>
          </div>
          <TeamMetric label="Review coverage received" value={pct(profile.review_coverage_received_pct, 1)} hint="Share of their merged MRs that had at least one reviewer." />
          <TeamMetric label="Large MRs" value={pct(profile.large_mr_pct, 1)} hint="Over 400 lines changed." />
          <TeamMetric label="Reverts authored" value={nf(profile.reverts_authored)} />
          <TeamMetric label="Review iterations (median)" value={nf(profile.median_review_iterations, 1)} hint="Commits pushed after the first review arrived. Often a sign review is working." />
        </DimensionCard>

        <DimensionCard name="Collaboration" question="Are they multiplying others?">
          <div className="mb-2">
            <BandPill band={profile.collaboration_band} />
            <span className="ml-2 text-[11px] text-[var(--color-muted)]">
              {BAND_LABEL[profile.collaboration_band]}
            </span>
          </div>
          <TeamMetric label="Reviews given" value={nf(profile.reviews_given)} />
          <TeamMetric label="Colleagues reviewed for" value={nf(profile.distinct_authors_reviewed)} />
          <TeamMetric label="Response time (median)" value={hours(profile.median_review_response_hours)} />
          <TeamMetric label="Review depth (median)" value={profile.median_review_depth_chars === null ? '—' : `${nf(profile.median_review_depth_chars)} chars`} />
          <TeamMetric label="Threads raised" value={nf(profile.threads_raised)} hint="Resolvable review threads — real requests rather than approvals." />
          <TeamMetric label="Reviews for more junior" value={nf(profile.mentoring_reviews)} hint="The closest telemetry gets to mentoring." />
        </DimensionCard>
      </div>

      <Card>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Volume, for context only
        </h4>
        <div className="mt-2 grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          <TeamMetric label="Merged MRs" value={nf(profile.merged_mrs)} />
          <TeamMetric label="Commits" value={nf(profile.commits)} />
          <TeamMetric label="Issues resolved" value={nf(profile.issues_resolved)} />
          <TeamMetric label="Story points" value={nf(profile.story_points)} />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
          These counts are not ranked and not banded. They vary enormously with the kind of work
          someone is assigned, and comparing them between people is the most common way a dashboard
          like this gets misused.
        </p>
      </Card>
    </div>
  )
}
