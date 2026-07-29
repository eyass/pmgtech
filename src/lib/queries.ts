import { supabaseAdmin } from '@/lib/supabase/admin'
import { loadBridgeCandidates, type BridgeRow } from '@/lib/sync/bridge'
import type {
  AssessmentRow,
  AssessmentSummaryRow,
  EngineerProfile,
  KnowledgeConcentrationRow,
  PerformanceDimension,
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

export async function getSquads(): Promise<SquadRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('squads')
    .select('id, key, name, description, colour, sort_order, is_active')
    .order('sort_order')
  if (error) throw new Error(`Failed to load squads: ${error.message}`)
  return (data ?? []) as SquadRow[]
}

export async function getSquadByKey(key: string): Promise<SquadRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('squads')
    .select('id, key, name, description, colour, sort_order, is_active')
    .eq('key', key)
    .maybeSingle()
  if (error) throw new Error(`Failed to load squad ${key}: ${error.message}`)
  return (data as SquadRow | null) ?? null
}

export async function getEngineers(): Promise<EngineerRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('engineers')
    .select(
      'id, email, full_name, display_name, avatar_url, job_title, department, site, manager_email, start_date, employment_type, is_active, include_in_metrics, include_in_metrics_source, seniority_key, seniority_source, squad_id, squad_source, hibob_id',
    )
    .order('full_name')
  if (error) throw new Error(`Failed to load engineers: ${error.message}`)
  return (data ?? []) as EngineerRow[]
}

export async function getEngineer(id: string): Promise<EngineerRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('engineers')
    .select(
      'id, email, full_name, display_name, avatar_url, job_title, department, site, manager_email, start_date, employment_type, is_active, include_in_metrics, include_in_metrics_source, seniority_key, seniority_source, squad_id, squad_source, hibob_id',
    )
    .eq('id', id)
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
  const rows = await loadBridgeCandidates(supabaseAdmin())
  return rows
    .filter((row) => row.verdict.action !== 'link' && row.verdict.action !== 'skip')
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

/** Whether any data has landed yet — drives the empty state on first deploy. */
export type SyncAlertLevel = 'warn' | 'bad'

export interface SyncAlert {
  source: string
  level: SyncAlertLevel
  message: string
}

/**
 * Sync problems worth interrupting someone about.
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
 */
export async function getSyncAlerts(): Promise<SyncAlert[]> {
  const { data, error } = await supabaseAdmin()
    .from('sync_runs')
    .select('source, mode, status, started_at, finished_at, stats')
    .order('started_at', { ascending: false })
    .limit(60)
  if (error) throw new Error(`Failed to load sync runs: ${error.message}`)

  const runs = (data ?? []) as {
    source: string
    mode: string
    status: string
    started_at: string
    finished_at: string | null
    stats: Record<string, unknown> | null
  }[]

  const alerts: SyncAlert[] = []
  const sources = ['gitlab', 'jira', 'hibob']

  for (const source of sources) {
    const forSource = runs.filter((r) => r.source === source || r.source === 'all')
    // A run still in flight says nothing about health either way.
    const finished = forSource.filter((r) => r.status !== 'running')
    if (finished.length === 0) continue

    const latest = finished[0]
    if (latest.status === 'error') {
      alerts.push({ source, level: 'bad', message: 'the last run failed' })
      continue
    }

    const lastSuccess = finished.find((r) => r.status === 'success')
    const hoursSince = lastSuccess?.finished_at
      ? (Date.now() - new Date(lastSuccess.finished_at).getTime()) / 3_600_000
      : null

    if (hoursSince === null) {
      // Every metric from this source is as old as whatever the partial runs managed.
      alerts.push({
        source,
        level: 'bad',
        message: `no run has completed yet — ${finished.length} attempt${
          finished.length === 1 ? '' : 's'
        } stopped early`,
      })
    } else if (hoursSince > 24) {
      alerts.push({
        source,
        level: hoursSince > 72 ? 'bad' : 'warn',
        message: `last completed ${Math.round(hoursSince)} hours ago`,
      })
    }

    // Consecutive partials mean the walk is not converging, even while data arrives.
    let consecutivePartial = 0
    for (const run of finished) {
      if (run.status !== 'partial') break
      consecutivePartial += 1
    }
    if (consecutivePartial >= 3) {
      alerts.push({
        source,
        level: 'warn',
        message: `${consecutivePartial} runs in a row stopped early — the backfill may not be advancing`,
      })
    }
  }

  return alerts
}

export async function getDataFreshness() {
  const db = supabaseAdmin()
  const [engineers, mrs, issues, lastRun] = await Promise.all([
    db.from('engineers').select('id', { count: 'exact', head: true }),
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
