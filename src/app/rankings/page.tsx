import Link from 'next/link'

import { DimensionBeeswarm, type DimensionBeeswarmEngineer } from '@/components/dimension-beeswarm'
import { HeadToHead } from '@/components/head-to-head'
import { RadarGrid } from '@/components/radar-grid'
import { RankDotPlot, type RankDotPlotRow } from '@/components/rank-dotplot'
import { RankSlope, type RankSlopeRow } from '@/components/rank-slope'
import { SquadComposition, type SquadCompositionRow } from '@/components/squad-composition'
import { SquadScatter, type SquadScatterRow } from '@/components/squad-scatter'
import { Card, MetricNote, SectionHeading } from '@/components/ui'
import { getEngineerOutliers, getSquadOutliers, getSquads, PERIODS, resolvePeriod } from '@/lib/queries'
import { medianProfile, type RadarSubject, type RadarValues } from '@/lib/radar-geometry'
import { tieSummary } from '@/lib/rank-bands'
import { confidenceStates, isSolidMark } from '@/lib/score-confidence'
import { driverTally } from '@/lib/score-drivers'
import { type EngineerOutlier } from '@/lib/types/performance'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Rankings — PMG Engineering Tracker' }

/**
 * Rankings: engineers and squads, ordered and placed, as visually as the data
 * supports.
 *
 * This page exists because `/outliers` had grown two jobs. That page explains how
 * the score is built and carries the auditable tables; this one answers the ranking
 * question directly and in pictures. The tables stay there deliberately — they are
 * the reachable-without-hover twin for every chart here.
 *
 * The order of the page is an argument, not a layout. It opens with how much of the
 * ranking is real (the tie bands), because with this org's data most of it is not:
 * eleven of fourteen engineers sit inside a fraction of one interquartile range, and
 * a reader who scrolls straight to a radar grid will happily read fourteen distinct
 * rungs into what is really about three. Precision first, then position, then shape.
 */
export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; squad?: string; a?: string; b?: string }>
}) {
  const { period, squad: squadFilter, a: aParam, b: bParam } = await searchParams
  const { key, range } = resolvePeriod(period)

  const squads = await getSquads()
  const selected = squadFilter ? squads.find((s) => s.key === squadFilter) : undefined

  const [engineers, squadRows] = await Promise.all([
    getEngineerOutliers(range, selected?.id),
    getSquadOutliers(range),
  ])

  const scored = engineers.filter((e) => e.score !== null)

  // --- engineer shapes -----------------------------------------------------

  const values = (e: EngineerOutlier): RadarValues => ({
    throughput: e.throughput_score,
    flow: e.flow_score,
    quality: e.quality_score,
    collaboration: e.collaboration_score,
  })

  const subject = (e: EngineerOutlier): RadarSubject => ({
    id: e.engineer_id,
    name: e.full_name,
    meta: [e.seniority_label ?? e.seniority_key, e.squad_name].filter(Boolean).join(' · ') || null,
    values: values(e),
    score: e.score,
    solid: isSolidMark(e.score_confidence),
    confidence: e.score_confidence,
    note: isSolidMark(e.score_confidence) ? null : e.confidence_reason,
  })

  const subjects = scored.map(subject)

  // --- what the page says about itself, counted -----------------------------
  //
  // Both of these were findings buried in an 11px legend under the first chart, and
  // both are computed here rather than restated: `tieSummary` is the same function
  // the dot plot's own legend reads, so the header and the chart cannot drift apart.
  const ties = tieSummary(scored.map((e) => ({ id: e.engineer_id, score: e.score })))
  const drivers = driverTally(scored.map((e) => ({ values: values(e) })))
  const partPeriod = confidenceStates(scored.map((e) => e.score_confidence)).find(
    (s) => s.confidence === 'partial_window',
  )

  // The org median rather than a per-level one: the grid draws a single backdrop, so
  // a different reference per cell would break the superposition it exists for. The
  // per-level comparison is what the head-to-head below is for.
  const orgReference =
    subjects.length > 0
      ? {
          label: 'Org median',
          values: medianProfile(subjects),
          detail: `median of ${subjects.length} scored engineer${subjects.length === 1 ? '' : 's'}`,
        }
      : undefined

  // --- head to head --------------------------------------------------------

  // Two engineers by id from the query string, so a comparison is linkable. Falls
  // back to the top two, which is the comparison someone opening this page wants.
  const pick = (id: string | undefined, fallback: RadarSubject | undefined) =>
    (id ? subjects.find((s) => s.id === id) : undefined) ?? fallback
  const left = pick(aParam, subjects[0])
  const right = pick(bParam, subjects.find((s) => s.id !== left?.id))
  const pair = [left, right].filter((s): s is RadarSubject => s !== undefined)

  // The reference for a pair is only honest when both sit at the same level — a
  // cohort median means nothing across two different ladders.
  const leftLevel = scored.find((e) => e.engineer_id === left?.id)
  const rightLevel = scored.find((e) => e.engineer_id === right?.id)
  const sameLevel =
    leftLevel && rightLevel && leftLevel.seniority_key === rightLevel.seniority_key
      ? leftLevel
      : undefined
  const peers = sameLevel
    ? scored.filter((e) => e.seniority_key === sameLevel.seniority_key)
    : []
  const pairReference =
    sameLevel && peers.length >= 3
      ? {
          label: `${sameLevel.seniority_label ?? sameLevel.seniority_key} median`,
          values: medianProfile(peers.map(subject)),
          detail: `median of ${peers.length} at this level`,
        }
      : undefined

  // --- squads --------------------------------------------------------------

  const squadScatter: SquadScatterRow[] = squadRows.map((s) => ({
    key: s.squad_key,
    name: s.squad_name,
    headcount: s.headcount,
    throughput: s.throughput_score,
    flow: s.flow_score,
    quality: s.quality_score,
    collaboration: s.collaboration_score,
    solid: isSolidMark(s.score_confidence),
    confidenceNote: isSolidMark(s.score_confidence) ? null : s.confidence_reason,
  }))

  const composition: SquadCompositionRow[] = squadRows.map((s) => ({
    key: s.squad_key,
    name: s.squad_name,
    squadScore: s.score,
    headcount: s.headcount,
    solid: isSolidMark(s.score_confidence),
    members: scored
      .filter((e) => e.squad_key === s.squad_key)
      .map((e) => ({
        id: e.engineer_id,
        name: e.full_name,
        score: e.score,
        level: e.seniority_label ?? e.seniority_key,
        confidence: e.score_confidence,
        note: isSolidMark(e.score_confidence) ? null : e.confidence_reason,
      })),
  }))

  const squadSubjects: RadarSubject[] = squadRows.map((s) => ({
    id: s.squad_key,
    name: s.squad_name,
    meta: `${s.headcount} in metrics`,
    values: {
      throughput: s.throughput_score,
      flow: s.flow_score,
      quality: s.quality_score,
      collaboration: s.collaboration_score,
    },
    score: s.score,
    solid: isSolidMark(s.score_confidence),
    note: isSolidMark(s.score_confidence) ? null : s.confidence_reason,
  }))

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Rankings</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {PERIODS[key].label}
            {selected ? ` · ${selected.name}` : ''} · {scored.length} engineers and{' '}
            {squadRows.length} squads
          </p>
          {/* The finding, in the header rather than in a legend below the fold. It is
              the sentence that decides how a reader should treat every other number
              on the page, and it was being made in 11px grey under the first chart.
              Computed from the live data by the same function the chart's own legend
              calls, so the two can never say different things. */}
          {ties.sentence ? (
            <p className="mt-1 text-sm">
              <strong className="font-semibold">{ties.sentence}</strong>
              <span className="text-[var(--color-muted)]">
                {' '}
                — they sit inside one interquartile range of each other, so the ordering
                between them is arithmetic rather than a finding.
              </span>
            </p>
          ) : null}
          {partPeriod ? (
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {partPeriod.count === 1 ? 'One engineer was' : `${partPeriod.count} engineers were`}{' '}
              here for only part of this period — still ranked, but left out of the cohort median
              they are ranked against. Drawn as a half-filled mark, not the hollow one that means
              thin data.
            </p>
          ) : null}
        </div>
        <Link href="/outliers" className="text-sm text-[var(--color-muted)] hover:underline">
          How the score is built →
        </Link>
      </div>

      {/* --- how much of the ranking is real --------------------------------- */}

      <section>
        <SectionHeading
          title="How much of this ranking is real"
          hint="Every engineer's composite, with the bands inside which two scores are not far enough apart to claim a difference."
        />
        <Card>
          <RankDotPlot rows={dotRows(scored)} />
        </Card>
        <MetricNote>
          A band is one <strong>interquartile range of a seniority cohort</strong>, which is 15
          points by construction — the same gate the banding logic already applies before it will
          say one engineer is above or below another. Inside a band the ordering is real arithmetic
          on numbers too close together to mean anything, so the rank numbers are drawn but the
          separation is not. Read the band edges as a lower bound on how much of this ranking is
          noise rather than as a boundary: two scores can land either side of an edge and still be
          within one range of each other.
        </MetricNote>
        <MetricNote>
          The <strong>driver</strong> column answers the other half of the question. A rank number
          says where somebody landed; the driver says which of the four dimensions put them there,
          and it is only filled in when that dimension is a full interquartile range from the
          cohort median. Here that is{' '}
          <strong>
            {drivers.driven} of {drivers.driven + drivers.even}
          </strong>
          , and the other {drivers.even} read <em>nothing separates</em> — which is the honest
          answer rather than a missing value. The gate is the same 15 points, for a reason worth
          knowing: a dimension that far from the median moves the composite by only a quarter of
          it, so <strong>no single dimension can ever move a composite materially on its own</strong>.
          That is why the driver is a claim about the dimension&apos;s own axis and not about the
          rank, and why a smaller gate would be naming a winner out of movement this page refuses
          to read anywhere else.
        </MetricNote>
      </section>

      {/* --- rank in org against rank at level ------------------------------- */}

      <section>
        <SectionHeading
          title="Against the org, against their own level"
          hint="The same engineer's two placings. A steep fall means the org rank was flattering their seniority; a climb means they are strong for their level."
        />
        <Card>
          <RankSlope rows={slopeRows(scored)} />
        </Card>
        <MetricNote>
          Org rank is the number people quote and the one that misleads, because it puts a
          mid-level engineer and a staff engineer in the same list. Level rank is the placing the
          score is actually built to support — every engineer is scored against the median of their
          own cohort, never against the org. Where a line is close to flat the two agree, which is
          what this org mostly shows: the cohorts here are large enough that seniority is not
          distorting placings much.
        </MetricNote>
      </section>

      {/* --- which dimension separates anyone -------------------------------- */}

      <section>
        <SectionHeading
          title="Which dimension is doing the separating"
          hint="All four dimensions, every engineer, with each row's median. The rows are not equally wide, and that is the finding."
        />
        <Card>
          <DimensionBeeswarm engineers={beeswarmRows(scored)} />
        </Card>
        <MetricNote>
          The composite hides this. Flow spreads engineers across most of the scale while quality
          spreads them across a fraction of it, so two people a few points apart overall can be far
          apart on one dimension and indistinguishable on another. A narrow row is not a row where
          everyone is equal — it is a row where this data cannot tell them apart, and the composite
          weights it the same 25% regardless.
        </MetricNote>
      </section>

      {/* --- profile shapes ------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Profile shapes"
          hint="Each engineer's four dimensions as one shape, against the org median. For reading what kind of engineer someone is — never for ranking them."
        />
        <Card>
          <RadarGrid subjects={subjects} sort="score" reference={orgReference} kind="engineers" />
        </Card>
        <MetricNote>
          A spiky shape is a specialist and an even one a generalist; neither is better, and the
          composite beside each name is what orders them. <strong>Do not read area as rank.</strong>{' '}
          A radar&apos;s area grows with the square of its values and changes if the axes are
          reordered, so the same four scores can be made to look bigger or smaller by drawing them
          differently — which is exactly why the number is printed and the axis order is fixed.
        </MetricNote>
      </section>

      {/* --- head to head --------------------------------------------------- */}

      {pair.length === 2 ? (
        <section>
          <SectionHeading
            title="Head to head"
            hint="Two engineers, dimension by dimension, with each difference marked material or not."
          />
          <Card>
            <HeadToHead subjects={pair} reference={pairReference} kind="engineers" />
          </Card>
          <MetricNote>
            Every dimension is labelled against the same 15-point gate as the bands above, so a
            two-point difference reads as <em>same</em> rather than as a win — this is the view
            most likely to be opened before a calibration conversation, and it is built to refuse
            to manufacture one.{' '}
            {pairReference
              ? 'The backdrop is the median profile of their shared level.'
              : 'No cohort backdrop is drawn: these two are not at the same level, or the level has fewer than three people, and a cohort median across two ladders would be meaningless.'}
          </MetricNote>
        </section>
      ) : null}

      {/* --- squads --------------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Squads, on the scale they are actually scored against"
          hint="Two dimensions at a time, bubble area by headcount. The lines are the target midpoint, not a median."
        />
        <Card>
          <SquadScatter rows={squadScatter} />
        </Card>
        <MetricNote>
          Squads are scored against <strong>absolute delivery targets</strong>, not against each
          other, so this plot never rescales to the data: 0 is the bad threshold, 100 the good one,
          and the crosshair is halfway between them. That is why the bubbles cluster against the
          top-right — this org clears most of its targets, and a fitted axis would spread that
          ceiling across the whole plot and manufacture a loser out of it. Bubble{' '}
          <strong>area</strong> is headcount, so a wide squad and a strong one are not confused.
        </MetricNote>
      </section>

      <section>
        <SectionHeading
          title="Uniform, or carried"
          hint="Each squad's own score beside the spread of its members' scores."
        />
        <Card>
          <SquadComposition rows={composition} />
        </Card>
        <MetricNote>
          The two columns are <strong>different scales and must not be compared across</strong>:
          a squad&apos;s score is measured against absolute targets, an engineer&apos;s against the
          median of their own seniority cohort. Compare down each column, never across the rule.
          What the member spread adds is the question a squad ranking cannot answer on its own —
          whether a high-placed squad is uniformly strong or is carrying a wide range, which is a
          staffing fact rather than a performance one.
        </MetricNote>
      </section>

      <section>
        <SectionHeading
          title="Squad profile shapes"
          hint="The same four dimensions per squad. 50 here is the target midpoint, not a median."
        />
        <Card>
          <RadarGrid subjects={squadSubjects} sort="score" kind="squads" />
        </Card>
      </section>
    </div>
  )
}

// --- row mappers ----------------------------------------------------------

function dotRows(rows: EngineerOutlier[]): RankDotPlotRow[] {
  return rows.map((e) => ({
    id: e.engineer_id,
    name: e.full_name,
    score: e.score,
    rank: e.rank_in_org,
    level: e.seniority_label ?? e.seniority_key,
    squad: e.squad_name,
    confidence: e.score_confidence,
    confidenceNote: isSolidMark(e.score_confidence) ? null : e.confidence_reason,
    values: {
      throughput: e.throughput_score,
      flow: e.flow_score,
      quality: e.quality_score,
      collaboration: e.collaboration_score,
    },
    standing: e.standing,
    net: e.net,
  }))
}

function slopeRows(rows: EngineerOutlier[]): RankSlopeRow[] {
  return rows.map((e) => ({
    id: e.engineer_id,
    name: e.full_name,
    shortName: shortName(e.full_name),
    rankInOrg: e.rank_in_org,
    rankAtLevel: e.rank_at_level,
    peersAtLevel: e.peers_at_level,
    level: e.seniority_label ?? e.seniority_key,
    squad: e.squad_name,
    score: e.score,
    confidence: e.score_confidence,
    confidenceNote: isSolidMark(e.score_confidence) ? null : e.confidence_reason,
  }))
}

function beeswarmRows(rows: EngineerOutlier[]): DimensionBeeswarmEngineer[] {
  return rows.map((e) => ({
    id: e.engineer_id,
    name: e.full_name,
    shortName: shortName(e.full_name),
    level: e.seniority_label ?? e.seniority_key,
    squad: e.squad_name,
    confidence: e.score_confidence,
    confidenceNote: isSolidMark(e.score_confidence) ? null : e.confidence_reason,
    throughput: e.throughput_score,
    flow: e.flow_score,
    quality: e.quality_score,
    collaboration: e.collaboration_score,
  }))
}

/** "Marcin Niemirski" → "Marcin N." — short enough to sit beside a mark. */
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/)
  if (parts.length < 2) return parts[0] ?? full
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`
}
