/**
 * Return shapes of the aggregation RPCs defined in supabase/migrations.
 * These are the contract between Postgres and the dashboard, so they are
 * maintained by hand and kept in step with the migrations.
 */

export type SquadKey = 'buyer' | 'seller' | 'monetization' | 'growth'

export interface SquadScorecard {
  squad_id: string
  squad_key: SquadKey
  squad_name: string
  colour: string
  headcount: number
  active_contributors: number
  merged_mrs: number
  open_mrs: number
  mrs_per_engineer_week: number | null
  median_cycle_hours: number | null
  p75_cycle_hours: number | null
  median_review_wait_hours: number | null
  review_coverage_pct: number | null
  median_mr_churn: number | null
  large_mr_pct: number | null
  reviews_given: number
  reviews_per_engineer_week: number | null
  commits: number
  code_churn: number
  prod_deploys: number
  deploys_per_week: number | null
  change_failure_pct: number | null
  mttr_hours: number | null
  issues_resolved: number
  story_points: number
  median_issue_cycle_hours: number | null
  bug_ratio_pct: number | null
}

export interface OrgKpis {
  headcount: number
  unassigned_engineers: number
  unmapped_identities: number
  merged_mrs: number
  open_mrs: number
  median_cycle_hours: number | null
  median_review_wait_hours: number | null
  review_coverage_pct: number | null
  mrs_per_engineer_week: number | null
  prod_deploys: number
  deploys_per_week: number | null
  change_failure_pct: number | null
  mttr_hours: number | null
  /**
   * How much of the requested period actually contains production-deployment data.
   * The three deploy metrics above are withheld (null) below 50%, because a weekly
   * rate extrapolated from a sliver of the window is not a rate.
   */
  deploy_coverage_pct: number | null
  issues_resolved: number
  story_points: number
  median_issue_cycle_hours: number | null
  bug_ratio_pct: number | null
  reviews_given: number
}

export interface TrendPoint {
  bucket: string
  squad_id: string
  squad_key: SquadKey
  merged_mrs: number
  issues_resolved: number
  prod_deploys: number
  median_cycle_hours: number | null
  commits: number
}

export interface EngineerScorecard {
  engineer_id: string
  full_name: string
  avatar_url: string | null
  job_title: string | null
  seniority_key: string
  seniority_label: string | null
  seniority_rank: number
  tenure_months: number | null
  squad_id: string | null
  squad_key: SquadKey | null
  squad_name: string | null
  merged_mrs: number
  open_mrs: number
  median_cycle_hours: number | null
  median_mr_churn: number | null
  code_churn: number
  commits: number
  reviews_given: number
  reviews_received: number
  median_review_response_hours: number | null
  distinct_authors_reviewed: number
  issues_resolved: number
  story_points: number
  median_issue_cycle_hours: number | null
  bugs_resolved: number
  last_active_at: string | null
}

export interface SeniorityBenchmarkRow {
  seniority_key: string
  seniority_label: string
  seniority_rank: number
  engineers: number
  median_merged_mrs: number | null
  median_cycle_hours: number | null
  median_reviews_given: number | null
  median_issues_resolved: number | null
  median_mr_churn: number | null
}

export interface ReviewNetworkRow {
  reviewer_squad_id: string
  reviewer_squad: string
  author_squad_id: string
  author_squad: string
  reviews: number
}

export interface SprintScorecard {
  sprint_id: string
  sprint_name: string
  state: string
  squad_id: string | null
  squad_key: SquadKey | null
  start_date: string | null
  end_date: string | null
  complete_date: string | null
  goal: string | null
  committed_issues: number
  added_issues: number
  total_issues: number
  completed_issues: number
  carryover_issues: number
  committed_points: number
  completed_points: number
  completion_pct: number | null
  scope_creep_pct: number | null
}

export interface WorkTypeMixRow {
  squad_id: string
  squad_key: SquadKey
  issue_type: string
  issues: number
  points: number
  share_pct: number | null
}

export interface AttentionRow {
  merge_request_id: string
  title: string | null
  web_url: string | null
  project_name: string
  author_name: string
  squad_id: string | null
  squad_key: SquadKey | null
  opened_at: string
  age_hours: number
  churn: number
  distinct_reviewers: number
  notes_count: number
  reason: string
}

export interface SquadRow {
  id: string
  key: SquadKey
  name: string
  description: string | null
  colour: string
  sort_order: number
  is_active: boolean
}

export interface EngineerRow {
  id: string
  email: string | null
  full_name: string
  display_name: string | null
  avatar_url: string | null
  job_title: string | null
  department: string | null
  site: string | null
  manager_email: string | null
  start_date: string | null
  employment_type: string | null
  is_active: boolean
  include_in_metrics: boolean
  seniority_key: string
  seniority_source: string
  squad_id: string | null
  squad_source: string
  hibob_id: string | null
}

export interface SyncRunRow {
  id: string
  source: 'gitlab' | 'jira' | 'hibob' | 'all'
  mode: 'incremental' | 'backfill'
  status: 'running' | 'success' | 'partial' | 'error'
  trigger: 'manual' | 'cron' | 'api'
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  stats: Record<string, unknown>
  error: string | null
}

export interface UnmatchedIdentityRow {
  id: string
  provider: 'gitlab' | 'jira'
  external_id: string
  external_handle: string | null
  display_name: string | null
  email: string | null
  event_count: number
  last_seen_at: string
}
