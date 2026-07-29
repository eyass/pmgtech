/** Return shapes for the four-dimension measurement framework. */

export type DimensionKey = 'flow' | 'quality' | 'collaboration' | 'impact'

/** Where someone sits against others at their own level. Never a rank. */
export type Band = 'below' | 'typical' | 'above' | 'insufficient'

/** Descriptive balance of shipping versus reviewing. Not a grade. */
export type Shape = 'Anchor' | 'Shipper' | 'Multiplier' | 'Quiet in telemetry' | 'No cohort'

export interface PerformanceDimension {
  key: DimensionKey
  name: string
  team_question: string
  individual_question: string
  what_it_sees: string
  what_it_cannot_see: string
  sort_order: number
}

export interface TeamHealth {
  squad_id: string
  squad_key: string
  squad_name: string
  colour: string
  headcount: number
  // flow
  median_cycle_hours: number | null
  p75_cycle_hours: number | null
  flow_efficiency_pct: number | null
  median_mr_churn: number | null
  wip_per_engineer: number | null
  deploys_per_week: number | null
  // quality
  change_failure_pct: number | null
  mttr_hours: number | null
  review_coverage_pct: number | null
  reverts: number
  production_bugs: number
  // collaboration
  reviews_per_engineer_week: number | null
  review_gini: number | null
  cross_squad_review_pct: number | null
  median_review_response_hours: number | null
  median_review_depth_chars: number | null
  // impact (context)
  unplanned_work_pct: number | null
  sprint_completion_pct: number | null
  story_points: number
  issues_resolved: number
}

export interface EngineerProfile {
  engineer_id: string
  full_name: string
  job_title: string | null
  seniority_key: string
  seniority_label: string | null
  tenure_months: number | null
  squad_id: string | null
  squad_key: string | null
  squad_name: string | null
  // volume context, deliberately unscored
  merged_mrs: number
  commits: number
  issues_resolved: number
  story_points: number
  // flow
  median_cycle_hours: number | null
  median_mr_churn: number | null
  open_mrs: number
  flow_efficiency_pct: number | null
  // quality
  review_coverage_received_pct: number | null
  large_mr_pct: number | null
  reverts_authored: number
  median_review_iterations: number | null
  // collaboration
  reviews_given: number
  distinct_authors_reviewed: number
  median_review_response_hours: number | null
  median_review_depth_chars: number | null
  threads_raised: number
  mentoring_reviews: number
  // interpretation
  peers_at_level: number
  sample_sufficient: boolean
  flow_band: Band
  quality_band: Band
  collaboration_band: Band
  shape: Shape
  last_active_at: string | null
}

export interface KnowledgeConcentrationRow {
  project_id: string
  project_name: string
  squad_id: string | null
  squad_key: string | null
  contributors: number
  commits: number
  top_author_name: string
  top_author_share_pct: number | null
}

export interface AssessmentRow {
  id: string
  engineer_id: string
  period_start: string
  period_end: string
  dimension_key: DimensionKey
  rating: number | null
  evidence: string | null
  assessed_by: string
  updated_at: string
}

export interface AssessmentSummaryRow {
  id: string
  engineer_id: string
  period_start: string
  period_end: string
  headline: string | null
  strengths: string | null
  growth: string | null
  assessed_by: string
  updated_at: string
}

/**
 * Team-level targets. These are the only place in the app where a metric is
 * judged against an absolute number, and they apply to squads, never to people.
 * Loosely calibrated on DORA's published performance bands; tune them to what
 * good looks like here rather than treating them as universal truth.
 */
export const TEAM_TARGETS = {
  deploys_per_week: { good: 5, bad: 1, direction: 'higher-better' as const },
  median_cycle_hours: { good: 24, bad: 120, direction: 'lower-better' as const },
  change_failure_pct: { good: 15, bad: 30, direction: 'lower-better' as const },
  mttr_hours: { good: 4, bad: 24, direction: 'lower-better' as const },
  flow_efficiency_pct: { good: 40, bad: 15, direction: 'higher-better' as const },
  review_coverage_pct: { good: 90, bad: 60, direction: 'higher-better' as const },
  median_review_response_hours: { good: 4, bad: 24, direction: 'lower-better' as const },
  // Gini above ~0.6 means review load sits on one or two people.
  review_gini: { good: 0.3, bad: 0.6, direction: 'lower-better' as const },
  cross_squad_review_pct: { good: 20, bad: 5, direction: 'higher-better' as const },
  sprint_completion_pct: { good: 80, bad: 50, direction: 'higher-better' as const },
  unplanned_work_pct: { good: 20, bad: 40, direction: 'lower-better' as const },
} as const

// 'typical' covers two cases on purpose: sitting in the middle of the cohort, and sitting
// near enough to the median that the difference is not worth a conversation. The RPC
// requires a material gap before it will say 'above' or 'below' at all, so the label says
// "no meaningful gap" rather than implying the engineer landed exactly on the median.
export const BAND_LABEL: Record<Band, string> = {
  above: 'Above typical for level',
  typical: 'No meaningful gap from others at level',
  below: 'Below typical for level',
  insufficient: 'Not enough data',
}

export const SHAPE_MEANING: Record<Shape, string> = {
  Anchor: 'Ships and reviews above the median for their level. Carries load in both directions.',
  Shipper: 'Ships above the median but reviews below it. Worth checking whether review is being crowded out.',
  Multiplier:
    'Reviews above the median while shipping below it. Often exactly right for a senior — their output is other people.',
  'Quiet in telemetry':
    'Below the median on both. This tool cannot see their work; it does not mean there was none. Design, incidents, pairing, on-call and mentoring are all invisible here.',
  'No cohort':
    'Fewer than three peers at this level, so there is no median to compare against — a shape here would only be measuring them against themselves.',
}


// --- scores and rankings (0021_outliers.sql) ---------------------------------

/**
 * How much weight the score can carry. The number is always produced; this says
 * whether to act on it.
 *
 *  - `high`      enough work in the window, and a cohort big enough to have a median
 *  - `thin`      too little work behind it, or a squad of one where a per-engineer
 *                rate is really one person's rate
 *  - `no_cohort` fewer than three peers at the level, so the median is nearly the
 *                person themselves
 */
export type ScoreConfidence = 'high' | 'thin' | 'no_cohort'

/** Whether the score's gap from the cohort is large enough to be worth saying. */
export type Standing = 'top' | 'bottom' | 'typical' | 'unread'

/**
 * Which unit the throughput dimension counted in. Chosen once org-wide (see
 * `0023_complexity_weighted_throughput.sql`): `complexity` means merge requests were
 * weighted by how much they contained, `count` means they were counted raw because
 * too little of the work has a measured size yet.
 */
export type ThroughputBasis = 'complexity' | 'count'

export interface EngineerOutlier {
  engineer_id: string
  full_name: string
  job_title: string | null
  seniority_key: string
  seniority_label: string | null
  peers_at_level: number
  squad_id: string | null
  squad_key: string | null
  squad_name: string | null
  /** 0-100 against their own seniority cohort. 50 is the cohort median. */
  score: number | null
  rank_in_org: number
  rank_at_level: number
  score_confidence: ScoreConfidence
  confidence_reason: string | null
  throughput_score: number | null
  flow_score: number | null
  quality_score: number | null
  collaboration_score: number | null
  /**
   * The materiality tally from 0018, carried alongside the score as the check on
   * its precision: two scores a point apart are the same score, and a `typical`
   * standing on both rows is what says so.
   */
  signals_above: number
  signals_below: number
  signals_read: number
  net: number
  standing: Standing
  flow_band: Band
  quality_band: Band
  collaboration_band: Band
  shape: Shape
  merged_mrs: number
  issues_resolved: number
  reviews_given: number
  distinct_authors_reviewed: number
  median_cycle_hours: number | null
  review_coverage_received_pct: number | null
  large_mr_pct: number | null
  reverts_authored: number
  last_active_at: string | null
  /**
   * Complexity-weighted merge requests, in units of "median merged MR for the
   * period". Null until sizes have been measured. Compare against `merged_mrs`: far
   * below it means their changes are smaller than the org's typical one.
   */
  effective_mrs: number | null
  points_per_mr: number | null
  median_churn: number | null
  /** Share of their merge requests at the trivial floor — 10 lines or fewer, one file. */
  trivial_mr_pct: number | null
  /** How much of *their* work has a measured size. Low means effective_mrs understates. */
  sized_mr_pct: number | null
  /** How much of the *org's* work has one. This is what picks the basis. */
  org_sized_mr_pct: number | null
  throughput_basis: ThroughputBasis
}

export interface SquadOutlier {
  squad_id: string
  squad_key: string
  squad_name: string
  colour: string
  headcount: number
  /** 0-100 against absolute targets, not against the other squads. */
  score: number | null
  rank_in_org: number
  score_confidence: ScoreConfidence
  confidence_reason: string | null
  throughput_score: number | null
  flow_score: number | null
  quality_score: number | null
  collaboration_score: number | null
  mrs_per_engineer_week: number | null
  deploys_per_week: number | null
  median_cycle_hours: number | null
  change_failure_pct: number | null
  mttr_hours: number | null
  review_coverage_pct: number | null
  reviews_per_engineer_week: number | null
  cycle_sample: number
  deploy_sample: number
  mttr_sample: number
  effective_mrs: number | null
  /** The weighted rate scored against the same 4/1 target as the raw one. */
  effective_mrs_per_engineer_week: number | null
  points_per_mr: number | null
  median_churn: number | null
  trivial_mr_pct: number | null
  sized_mr_pct: number | null
  throughput_basis: ThroughputBasis
}

/**
 * The squad rubric, mirrored from `0021_outliers.sql` so the UI can show what each
 * number was scored against. Six of these thresholds are the team targets above;
 * `mrs_per_engineer_week` and `reviews_per_engineer_week` are set from this org's
 * own spread and are the two most arguable numbers in the scoring.
 */
export const SQUAD_SCORE_RUBRIC = {
  throughput: {
    label: 'Throughput',
    metrics: [
      { key: 'mrs_per_engineer_week', label: 'MRs per engineer per week', good: 4, bad: 1, weight: 2 },
      { key: 'deploys_per_week', label: 'Production releases per week', good: 5, bad: 1, weight: 1 },
    ],
  },
  flow: {
    label: 'Flow',
    metrics: [{ key: 'median_cycle_hours', label: 'Cycle time (median)', good: 24, bad: 120, weight: 1 }],
  },
  quality: {
    label: 'Quality',
    metrics: [
      { key: 'change_failure_pct', label: 'Change failure rate', good: 15, bad: 30, weight: 1 },
      { key: 'mttr_hours', label: 'Time to restore', good: 4, bad: 24, weight: 1 },
    ],
  },
  collaboration: {
    label: 'Collaboration',
    metrics: [
      { key: 'review_coverage_pct', label: 'Review coverage', good: 90, bad: 60, weight: 1 },
      { key: 'reviews_per_engineer_week', label: 'Reviews per engineer per week', good: 8, bad: 2, weight: 1 },
    ],
  },
} as const

/** What each engineer dimension is built from, for the same reason. */
export const ENGINEER_SCORE_RUBRIC = {
  throughput:
    'Complexity-weighted merge requests (×2) and resolved issues (×1), against the level median',
  flow: 'Median cycle time, against the level median',
  quality: 'Review coverage received (×2), large-MR share (×1) and reverts authored (×1)',
  collaboration: 'Reviews given (×2) and colleagues reviewed for (×1)',
} as const

/** Colour a 0-100 score. Deliberately wide in the middle: 50 is the median, not a fail. */
export function scoreTone(score: number | null | undefined): 'good' | 'warn' | 'bad' | 'neutral' {
  if (score === null || score === undefined) return 'neutral'
  if (score >= 65) return 'good'
  if (score < 35) return 'bad'
  if (score < 45) return 'warn'
  return 'neutral'
}

/**
 * How a merge request's size becomes a weight (`0022_change_size_and_complexity.sql`),
 * mirrored here so the UI can explain a number rather than just show it.
 */
export const COMPLEXITY_RUBRIC = {
  formula: 'log₂(1 + churn ÷ median churn) × breadth, capped at 6, floored at 0.1',
  unit: 'One point is the org’s median merged merge request for the period',
  trivialFloor: '10 lines or fewer in a single file scores 0.1 — a twentieth of a median MR',
  cap: 'Capped at 6 so one vendored-dependency dump cannot outscore a quarter of real work',
  breadth: 'Up to 1.5× for a change spread across many files',
  blindSpot:
    'Nothing here parses source, so nesting and cleverness are invisible. A hard one-line fix scores 0.1 like a typo — that case needs a human.',
} as const

/** Coverage below this and throughput falls back to counting merge requests. */
export const COMPLEXITY_COVERAGE_FLOOR = 60
