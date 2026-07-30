import { supabaseAdmin } from '@/lib/supabase/admin'
import { loadBridgeCandidates, type BridgeRow } from '@/lib/sync/bridge'
import {
  describeTargetChange,
  resolveMetricTargets,
  type MetricTargetChangeRow,
  type MetricTargetResolution,
  type MetricTargetRow,
  type MetricTargetSet,
  type TargetChange,
} from '@/lib/targets'
import {
  readSourceHealth,
  type SourceHealth,
  type SyncAlert,
  type SyncRunFacts,
} from '@/lib/trust'
import type {
  AssessmentRow,
  AssessmentSummaryRow,
  EngineerOutlier,
  EngineerProfile,
  KnowledgeConcentrationRow,
  PerformanceDimension,
  SquadOutlier,
  TeamHealth,
} from '@/lib/types/performance'
import type {
  AttentionRow,
  EngineerRow,
  EngineerScorecard,
  OrgKpis,
  ReviewNetworkRow,
  SeniorityBenchmarkRow,
  SprintScorecard,
  SquadKey,
  SquadRow,
  SquadScorecard,
  SyncRunRow,
  TrendPoint,
  UnmatchedIdentityRow,
  WorkTypeMixRow,
} from '@/lib/types/metrics'

/**
 * Read layer. Every function is a single RPC or select against the service-role
 * client, called from server components. Postgres does the aggregation.
 */

export interface DateRange {
  from: Date
  to: Date
}

/** Named windows offered in the UI's period picker. */
export const PERIODS = {
  '7d': { label: 'Last 7 days', short: '7d', days: 7, bucket: 'day' as const },
  '30d': { label: 'Last 30 days', short: '30d', days: 30, bucket: 'day' as const },
  '90d': { label: 'Last 90 days', short: '90d', days: 90, bucket: 'week' as const },
  '180d': { label: 'Last 6 months', short: '6m', days: 180, bucket: 'week' as const },
  '365d': { label: 'Last 12 months', short: '12m', days: 365, bucket: 'month' as const },
} as const

export type PeriodKey = keyof typeof PERIODS

export function resolvePeriod(key: string | undefined): {
  key: PeriodKey
  range: DateRange
  bucket: 'day' | 'week' | 'month'
} {
  const periodKey: PeriodKey = key && key in PERIODS ? (key as PeriodKey) : '90d'
  const period = PERIODS[periodKey]
  const to = new Date()
  const from = new Date(to.getTime() - period.days * 86_400_000)
  return { key: periodKey, range: { from, to }, bucket: period.bucket }
}

function rangeArgs(range: DateRange) {
  return { p_from: range.from.toISOString(), p_to: range.to.toISOString() }
}

/** RPCs return null on an empty result set; callers always want an array. */
async function rpcRows<T>(name: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabaseAdmin().rpc(name, args)
  if (error) throw new Error(`${name} failed: ${error.message}`)
  return (data ?? []) as T[]
}

export async function getOrgKpis(range: DateRange): Promise<OrgKpis> {
  const { data, error } = await supabaseAdmin().rpc('org_kpis', rangeArgs(range))
  if (error) throw new Error(`org_kpis failed: ${error.message}`)
  return data as OrgKpis
}

export function getSquadScorecards(range: DateRange) {
  return rpcRows<SquadScorecard>('squad_scorecards', rangeArgs(range))
}

export function getDeliveryTrend(
  range: DateRange,
  bucket: 'day' | 'week' | 'month',
  squadId?: string,
) {
  return rpcRows<TrendPoint>('delivery_trend', {
    ...rangeArgs(range),
    p_bucket: bucket,
    p_squad_id: squadId ?? null,
  })
}

export function getEngineerScorecards(range: DateRange, squadId?: string) {
  return rpcRows<EngineerScorecard>('engineer_scorecards', {
    ...rangeArgs(range),
    p_squad_id: squadId ?? null,
  })
}

export function getSeniorityBenchmark(range: DateRange, squadId?: string) {
  return rpcRows<SeniorityBenchmarkRow>('seniority_benchmark', {
    ...rangeArgs(range),
    p_squad_id: squadId ?? null,
  })
}

export function getReviewNetwork(range: DateRange) {
  return rpcRows<ReviewNetworkRow>('review_network', rangeArgs(range))
}

export function getSprintScorecards(squadId?: string, limit = 8) {
  return rpcRows<SprintScorecard>('sprint_scorecards', {
    p_squad_id: squadId ?? null,
    p_limit: limit,
  })
}

export function getWorkTypeMix(range: DateRange) {
  return rpcRows<WorkTypeMixRow>('work_type_mix', rangeArgs(range))
}

export function getAttentionList(squadId?: string, limit = 25) {
  return rpcRows<AttentionRow>('mr_attention_list', {
    p_squad_id: squadId ?? null,
    p_limit: limit,
  })
}

// --- plain table reads --------------------------------------------------------
//
// The aggregation RPCs and views handle ignored rows themselves (migration 0020),
// but these selects go straight at the tables, so they filter here. Each has an
// `…ForAdmin` twin that does not: the admin screen is the one place an ignored row
// has to be visible, because it is where someone restores it.

const SQUAD_COLUMNS = 'id, key, name, description, colour, sort_order, is_active, is_ignored'

const ENGINEER_COLUMNS =
  'id, email, full_name, display_name, avatar_url, job_title, department, site, manager_email, start_date, employment_type, is_active, include_in_metrics, include_in_metrics_source, seniority_key, seniority_source, squad_id, squad_source, hibob_id, is_ignored, ignored_source'

export async function getSquads(): Promise<SquadRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('squads')
    .select(SQUAD_COLUMNS)
    .eq('is_ignored', false)
    .order('sort_order')
  if (error) throw new Error(`Failed to load squads: ${error.message}`)
  return (data ?? []) as SquadRow[]
}

/** Every squad, ignored ones included. Admin screen only. */
export async function getSquadsForAdmin(): Promise<SquadRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('squads')
    .select(SQUAD_COLUMNS)
    .order('sort_order')
  if (error) throw new Error(`Failed to load squads: ${error.message}`)
  return (data ?? []) as SquadRow[]
}

/** Null for an ignored squad, which is what turns /squads/[key] into a 404 for it. */
export async function getSquadByKey(key: string): Promise<SquadRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('squads')
    .select(SQUAD_COLUMNS)
    .eq('key', key)
    .eq('is_ignored', false)
    .maybeSingle()
  if (error) throw new Error(`Failed to load squad ${key}: ${error.message}`)
  return (data as SquadRow | null) ?? null
}

export async function getEngineers(): Promise<EngineerRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('engineers')
    .select(ENGINEER_COLUMNS)
    .eq('is_ignored', false)
    .order('full_name')
  if (error) throw new Error(`Failed to load engineers: ${error.message}`)
  return (data ?? []) as EngineerRow[]
}

/** Everyone, ignored rows included. Admin screen only. */
export async function getEngineersForAdmin(): Promise<EngineerRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('engineers')
    .select(ENGINEER_COLUMNS)
    .order('full_name')
  if (error) throw new Error(`Failed to load engineers: ${error.message}`)
  return (data ?? []) as EngineerRow[]
}

/** Null for an ignored person, which is what turns /people/[id] into a 404 for them. */
export async function getEngineer(id: string): Promise<EngineerRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('engineers')
    .select(ENGINEER_COLUMNS)
    .eq('id', id)
    .eq('is_ignored', false)
    .maybeSingle()
  if (error) throw new Error(`Failed to load engineer: ${error.message}`)
  return (data as EngineerRow | null) ?? null
}

export async function getSyncRuns(limit = 20): Promise<SyncRunRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('sync_runs')
    .select('id, source, mode, status, trigger, started_at, finished_at, duration_ms, stats, error')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`Failed to load sync runs: ${error.message}`)
  return (data ?? []) as SyncRunRow[]
}

export async function getUnmatchedIdentities(): Promise<UnmatchedIdentityRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('unmatched_identities')
    .select('id, provider, external_id, external_handle, display_name, email, event_count, last_seen_at')
    .eq('dismissed', false)
    .order('event_count', { ascending: false })
    .limit(100)
  if (error) throw new Error(`Failed to load unmatched identities: ${error.message}`)
  return (data ?? []) as UnmatchedIdentityRow[]
}

/**
 * Commit-bridge suggestions the sync did not act on by itself, strongest first.
 *
 * Read-only: the classification is recomputed from current data every time rather than
 * stored, so accepting one suggestion or marking an account a bot makes the rest
 * recalculate instead of going stale.
 */
export async function getBridgeSuggestions(): Promise<BridgeRow[]> {
  const db = supabaseAdmin()
  const [rows, ignored] = await Promise.all([
    loadBridgeCandidates(db),
    db.from('engineers').select('id').eq('is_ignored', true),
  ])
  // A suggestion pointing at an ignored person is not worth offering: accepting it
  // writes a link whose whole point is to make history visible, and that history
  // would stay hidden. The account keeps showing up under unmapped identities.
  const ignoredIds = new Set(((ignored.data ?? []) as { id: string }[]).map((r) => r.id))
  return rows
    .filter((row) => row.verdict.action !== 'link' && row.verdict.action !== 'skip')
    .filter((row) => !(row.engineerId && ignoredIds.has(row.engineerId)))
    .sort((a, b) => b.mrs - a.mrs)
}

export interface SquadSuggestionRow {
  engineer_id: string
  full_name: string
  job_title: string | null
  squad_id: string
  squad_key: SquadKey
  squad_name: string
  issues: number
  total_issues: number
  share_pct: number | null
  mrs: number
}

/**
 * Squads suggested for engineers who have none, from the Jira boards their issues sit on.
 *
 * Suggestions rather than assignments: squad membership is an organisational fact, and a
 * wrong one silently misattributes everything the person does.
 */
export function getSquadSuggestions() {
  return rpcRows<SquadSuggestionRow>('squad_suggestions', {})
}

export interface GitLabProjectRow {
  id: string
  gitlab_id: number
  name: string
  path_with_namespace: string
  squad_id: string | null
  is_tracked: boolean
  archived: boolean
  last_activity_at: string | null
}

export async function getGitLabProjects(): Promise<GitLabProjectRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('gitlab_projects')
    .select('id, gitlab_id, name, path_with_namespace, squad_id, is_tracked, archived, last_activity_at')
    .order('last_activity_at', { ascending: false, nullsFirst: false })
  if (error) throw new Error(`Failed to load GitLab projects: ${error.message}`)
  return (data ?? []) as GitLabProjectRow[]
}

export interface JiraBoardRow {
  id: string
  jira_id: string
  name: string
  board_type: string | null
  project_key: string | null
  squad_id: string | null
  is_tracked: boolean
}

export async function getJiraBoards(): Promise<JiraBoardRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('jira_boards')
    .select('id, jira_id, name, board_type, project_key, squad_id, is_tracked')
    .order('name')
  if (error) throw new Error(`Failed to load Jira boards: ${error.message}`)
  return (data ?? []) as JiraBoardRow[]
}

// --- performance framework ----------------------------------------------------

export function getTeamHealth(range: DateRange) {
  return rpcRows<TeamHealth>('team_health', rangeArgs(range))
}

/**
 * Individual profiles. Percentile bands are computed inside the RPC against the
 * engineer's own seniority cohort and suppressed when the sample is too small,
 * so callers cannot accidentally produce an org-wide ranking.
 */
export function getEngineerProfiles(range: DateRange, squadId?: string, engineerId?: string) {
  return rpcRows<EngineerProfile>('engineer_profiles', {
    ...rangeArgs(range),
    p_squad_id: squadId ?? null,
    p_engineer_id: engineerId ?? null,
  })
}

/**
 * Who is standing out, at both altitudes.
 *
 * Both RPCs are tallies over bands that already exist — `engineer_profiles` for
 * people, `squad_scorecards` for squads — so the guardrails (within-level cohorts,
 * sample and cohort minimums, materiality gates) are inherited rather than
 * re-implemented, and a caller cannot get a ranking that bypasses them.
 */
export function getEngineerOutliers(range: DateRange, squadId?: string) {
  return rpcRows<EngineerOutlier>('engineer_outliers', {
    ...rangeArgs(range),
    p_squad_id: squadId ?? null,
  })
}

export function getSquadOutliers(range: DateRange) {
  return rpcRows<SquadOutlier>('squad_outliers', rangeArgs(range))
}

export function getKnowledgeConcentration(range: DateRange) {
  return rpcRows<KnowledgeConcentrationRow>('knowledge_concentration', rangeArgs(range))
}

export async function getPerformanceDimensions(): Promise<PerformanceDimension[]> {
  const { data, error } = await supabaseAdmin()
    .from('performance_dimensions')
    .select('key, name, team_question, individual_question, what_it_sees, what_it_cannot_see, sort_order')
    .order('sort_order')
  if (error) throw new Error(`Failed to load dimensions: ${error.message}`)
  return (data ?? []) as PerformanceDimension[]
}

/** The current review period: calendar quarter containing `on`. */
export function currentPeriod(on = new Date()): { start: string; end: string; label: string } {
  const q = Math.floor(on.getUTCMonth() / 3)
  const start = new Date(Date.UTC(on.getUTCFullYear(), q * 3, 1))
  const end = new Date(Date.UTC(on.getUTCFullYear(), q * 3 + 3, 0))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { start: iso(start), end: iso(end), label: `Q${q + 1} ${on.getUTCFullYear()}` }
}

export async function getAssessments(
  engineerId: string,
  periodStart: string,
  periodEnd: string,
): Promise<AssessmentRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('engineer_assessments')
    .select('id, engineer_id, period_start, period_end, dimension_key, rating, evidence, assessed_by, updated_at')
    .eq('engineer_id', engineerId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
  if (error) throw new Error(`Failed to load assessments: ${error.message}`)
  return (data ?? []) as AssessmentRow[]
}

export async function getAssessmentSummary(
  engineerId: string,
  periodStart: string,
  periodEnd: string,
): Promise<AssessmentSummaryRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('assessment_summaries')
    .select('id, engineer_id, period_start, period_end, headline, strengths, growth, assessed_by, updated_at')
    .eq('engineer_id', engineerId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle()
  if (error) throw new Error(`Failed to load assessment summary: ${error.message}`)
  return (data as AssessmentSummaryRow | null) ?? null
}

/**
 * Re-exported so the many callers that already import these from here keep working;
 * they are declared in `@/lib/trust` alongside the function that produces them.
 */
export type { SyncAlert, SyncAlertLevel } from '@/lib/trust'

/**
 * Per-source sync health.
 *
 * A broken sync does not look broken on a dashboard — it looks like a quiet week. Deploy
 * frequency falls, throughput dips, and every number is wrong in the same believable
 * direction. So the failure modes are checked explicitly rather than left to be noticed:
 *
 *  - a source whose most recent run errored;
 *  - a source with no successful run in over a day, including one that has never had one;
 *  - a source stuck in 'partial' for several consecutive runs, which is the one that
 *    actually happened: the Jira backfill spent eight runs re-processing the same 560
 *    issues because it restarted at the window start each time, and nothing said so.
 *
 * The judgement itself is `readSourceHealth`, which is pure and tested. This function
 * only fetches the rows, so the banner and the freshness table on `/trust` are one
 * judgement rendered twice rather than two that happen to agree today.
 */
export async function getSourceHealth(): Promise<SourceHealth[]> {
  const { data, error } = await supabaseAdmin()
    .from('sync_runs')
    .select('source, mode, status, started_at, finished_at, stats')
    .order('started_at', { ascending: false })
    .limit(60)
  if (error) throw new Error(`Failed to load sync runs: ${error.message}`)
  return readSourceHealth((data ?? []) as SyncRunFacts[])
}

/** The sync banner's contents: every source's alerts, worst source first as before. */
export async function getSyncAlerts(): Promise<SyncAlert[]> {
  return (await getSourceHealth()).flatMap((source) => source.alerts)
}

export async function getDataFreshness() {
  const db = supabaseAdmin()
  const [engineers, mrs, issues, lastRun] = await Promise.all([
    db.from('engineers').select('id', { count: 'exact', head: true }).eq('is_ignored', false),
    db.from('merge_requests').select('id', { count: 'exact', head: true }),
    db.from('jira_issues').select('id', { count: 'exact', head: true }),
    db
      .from('sync_runs')
      .select('source, status, finished_at')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return {
    engineers: engineers.count ?? 0,
    mergeRequests: mrs.count ?? 0,
    issues: issues.count ?? 0,
    hasAnyData: (engineers.count ?? 0) > 0 || (mrs.count ?? 0) > 0 || (issues.count ?? 0) > 0,
    lastRun: (lastRun.data as { source: string; status: string; finished_at: string | null } | null) ?? null,
  }
}

// --- delivery targets (0027_configurable_targets.sql) ------------------------

/**
 * The thresholds every squad metric is scored and coloured against.
 *
 * Deliberately does not throw. Every other read here fails loudly, because a page
 * with no data is better than a page with wrong data — but a target is not data,
 * it is the yardstick, and the yardstick has a defensible default sitting in code.
 * Falling back to it and saying so beats failing the whole page, and it is also
 * what keeps a missing row from reading as a zero: see `resolveMetricTargets`.
 */
export async function getMetricTargets(): Promise<MetricTargetResolution> {
  const { data, error } = await supabaseAdmin()
    .from('metric_targets')
    .select(
      'metric_key, label, good, bad, direction, score_dimension, score_weight, rationale, sort_order, updated_at, updated_by',
    )
    .order('sort_order')
  if (error) return resolveMetricTargets(null, error.message)
  return resolveMetricTargets((data ?? []) as MetricTargetRow[])
}

/**
 * The audit trail, newest first, already turned into readable changes.
 *
 * Same tolerance as above: an unreadable history is a gap in an explanation, not a
 * reason for the admin screen to 500.
 */
export async function getMetricTargetHistory(
  targets: MetricTargetSet,
  limit = 40,
): Promise<{ changes: TargetChange[]; error: string | null }> {
  const { data, error } = await supabaseAdmin()
    .from('metric_target_changes')
    .select(
      'id, metric_key, changed_by, changed_at, old_good, old_bad, new_good, new_bad, old_weight, new_weight, direction, note',
    )
    .order('changed_at', { ascending: false })
    .limit(limit)
  if (error) return { changes: [], error: error.message }
  return {
    changes: ((data ?? []) as MetricTargetChangeRow[]).map((row) =>
      describeTargetChange(row, targets),
    ),
    error: null,
  }
}
