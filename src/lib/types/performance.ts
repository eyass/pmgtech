/** Return shapes for the four-dimension measurement framework. */

export type DimensionKey = 'flow' | 'quality' | 'collaboration' | 'impact'

/** Where someone sits against others at their own level. Never a rank. */
export type Band = 'below' | 'typical' | 'above' | 'insufficient'

/** Descriptive balance of shipping versus reviewing. Not a grade. */
export type Shape = 'Anchor' | 'Shipper' | 'Multiplier' | 'Quiet in telemetry'

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

export const BAND_LABEL: Record<Band, string> = {
  above: 'Above typical for level',
  typical: 'Typical for level',
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
}
