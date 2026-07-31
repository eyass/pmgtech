/**
 * Return shapes of the aggregation RPCs defined in supabase/migrations.
 * These are the contract between Postgres and the dashboard, so they are
 * maintained by hand and kept in step with the migrations.
 */

/**
 * Squads are rows in `squads`, not a fixed set — DevExp was added after the
 * four product squads, and the admin screen can add more. Kept as a named
 * string so the RPC shapes below still read as squad keys rather than
 * anonymous strings.
 */
export type SquadKey = string

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

  /**
   * Sample counts behind the medians and ratios above, on the same 20-observation
   * floor org_kpis uses so squad and org figures can be compared. Below the floor the
   * metric is null: a squad median built on one issue read as a twenty-fold advantage
   * over a squad with two hundred, which is what motivated the guard.
   */
  cycle_sample: number
  review_wait_sample: number
  deploy_sample: number
  mttr_sample: number
  issue_cycle_sample: number
  story_points_sample: number
  /** Share of the period spanned by this squad's production releases. */
  deploy_coverage_pct: number
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
  /**
   * Withheld (null) when fewer than half of resolved issues carry an estimate. A sum
   * over a field a tenth of issues populate is a lower bound that moves when people
   * start estimating rather than when output changes.
   */
  story_points: number | null
  story_points_coverage_pct: number
  median_issue_cycle_hours: number | null
  bug_ratio_pct: number | null
  reviews_given: number

  /**
   * How many observations each metric rests on. The medians and ratios above are
   * withheld (null) below a 20-observation floor: a median of four merge requests
   * is a single anecdote wearing a statistic's clothes, and it renders identically
   * to one built from fifteen hundred unless the count travels with it.
   */
  cycle_sample: number
  review_wait_sample: number
  review_coverage_sample: number
  deploy_sample: number
  mttr_sample: number
  story_points_sample: number
  issue_cycle_sample: number

  /**
   * Share of activity in the period that resolved to a known engineer. Every
   * per-person and per-squad number is a slice of this: at 53.7% MR attribution,
   * a squad total is a lower bound, not a total.
   */
  mr_attribution_pct: number | null
  commit_attribution_pct: number | null
  unattributed_mrs: number
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
  /**
   * Taken out of the product altogether — a placeholder squad, or one that never
   * existed outside a spreadsheet. Only the admin screen ever sees a true here;
   * every other read path filters these rows out. See migration 0020.
   */
  is_ignored: boolean
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
  /**
   * Where `start_date` came from (migration 0028). 'manual' is never overwritten
   * by the HiBob sync, including when the manual answer is "no date" — see
   * `src/lib/sync/hibob.ts`.
   */
  start_date_source: 'unknown' | 'hibob' | 'manual'
  employment_type: string | null
  is_active: boolean
  include_in_metrics: boolean
  /** 'auto' = derived from the job title by the sync; 'manual' = set in the admin screen. */
  include_in_metrics_source: 'auto' | 'manual'
  seniority_key: string
  seniority_source: string
  squad_id: string | null
  squad_source: string
  hibob_id: string | null
  /**
   * Taken out of the product altogether: not a head, not a cohort member, and
   * nothing they authored, reviewed or was assigned counts anywhere. Stronger than
   * `include_in_metrics`, which only gates denominators. Only the admin screen ever
   * sees a true here. See migration 0020.
   */
  is_ignored: boolean
  /** 'squad' means they were ignored by their squad being ignored, not in their own right. */
  ignored_source: 'manual' | 'squad'
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
