import { appEnv, jiraEnv } from '@/lib/env'
import {
  JIRA_ISSUE_PAGE_CAP,
  JiraClient,
  looksLikeProductionBug,
  type JiraChangelogEntry,
  type JiraIssue,
  type JiraSprint,
} from '@/lib/integrations/jira'
import { IdentityResolver } from '@/lib/sync/identity'
import { planCursorAdvance } from '@/lib/sync/pagination'
import { SyncContext, upsertInChunks, type SyncMode, type SyncTrigger } from '@/lib/sync/runner'

/**
 * Jira sync. Pulls projects, boards, sprints and issues, plus the changelog that
 * makes cycle time and sprint carryover measurable.
 *
 * Boards are the anchor for squad attribution — map each board to a squad once in
 * the admin screen and every sprint and issue on it follows automatically.
 */
export async function syncJira(
  mode: SyncMode = 'incremental',
  trigger: SyncTrigger = 'manual',
  options: { budgetMs?: number } = {},
) {
  const ctx = new SyncContext('jira', mode, trigger, options.budgetMs)
  await ctx.start()

  const stats = {
    projects: 0,
    boards: 0,
    /** Boards left out: personal views, and boards owned by unconfigured projects. */
    boards_ignored: 0,
    sprints: 0,
    issues: 0,
    transitions: 0,
    issue_sprint_links: 0,
    unmatched_identities: 0,
    ran_out_of_time: 0,
    /** Set when the forward walk reached the present with nothing left behind. */
    backfill_complete: 0,
  }

  try {
    const client = new JiraClient()
    const env = jiraEnv()
    const backfillMonths = appEnv().backfillMonths

    if (env.projectKeys.length === 0) {
      throw new Error('JIRA_PROJECT_KEYS is empty — nothing to sync')
    }

    const identities = new IdentityResolver(ctx.db)
    await identities.load()

    // --- projects -------------------------------------------------------------

    ctx.log(`Fetching projects: ${env.projectKeys.join(', ')}`)
    const projects = await client.projects(env.projectKeys)
    if (projects.length > 0) {
      await upsertInChunks(
        ctx.db,
        'jira_projects',
        projects.map((p) => ({
          jira_id: p.id,
          key: p.key,
          name: p.name,
          project_type: p.projectTypeKey ?? null,
        })),
        'key',
      )
    }
    stats.projects = projects.length

    // --- boards and sprints ---------------------------------------------------

    const configuredKeys = new Set(projects.map((p) => p.key))
    const discovered = await client.boards(projects.map((p) => p.key))

    // Jira's board endpoint takes projectKeyOrId but answers with boards that merely
    // contain issues from that project, so a board owned by an unconfigured project
    // comes back too. location.projectKey is the board's own project, and that is
    // what decides whether it belongs here.
    const owned = discovered.filter(
      (b) => b.location?.projectKey && configuredKeys.has(b.location.projectKey),
    )
    const foreign = discovered.length - owned.length
    if (foreign > 0) {
      ctx.log(`Ignored ${foreign} board(s) owned by projects outside JIRA_PROJECT_KEYS`)
    }

    // Personal boards are one person's view of a project, not the team's board, so
    // they must not carry sprint metrics for a squad.
    const ignorePatterns = await loadIgnoredBoardPatterns(ctx)
    const isIgnored = (name: string) => {
      const n = name.toLowerCase()
      return ignorePatterns.some((pattern) => n.includes(pattern))
    }

    const boards = owned.filter((b) => !isIgnored(b.name))
    const ignored = owned.filter((b) => isIgnored(b.name))
    if (ignored.length > 0) {
      ctx.log(`Not tracking ${ignored.length} personal board(s): ${ignored.map((b) => b.name).join(', ')}`)
    }

    if (owned.length > 0) {
      await upsertInChunks(
        ctx.db,
        'jira_boards',
        owned.map((b) => ({
          jira_id: String(b.id),
          name: b.name,
          board_type: b.type ?? null,
          project_key: b.location?.projectKey ?? null,
          is_tracked: !isIgnored(b.name),
        })),
        'jira_id',
      )
    }
    stats.boards = boards.length
    stats.boards_ignored = ignored.length + foreign

    const boardIdMap = await loadBoardIds(ctx)
    const sprintsByJiraId = new Map<string, { id: string; startDate: string | null; completeDate: string | null }>()

    for (const board of boards) {
      const dbBoard = boardIdMap.get(String(board.id))
      if (!dbBoard || !dbBoard.isTracked) continue

      const sprints = await client.sprints(board.id)
      if (sprints.length === 0) continue

      await upsertInChunks(
        ctx.db,
        'jira_sprints',
        sprints.map((s: JiraSprint) => ({
          jira_id: String(s.id),
          board_id: dbBoard.id,
          name: s.name,
          state: s.state,
          goal: s.goal ?? null,
          start_date: s.startDate ?? null,
          end_date: s.endDate ?? null,
          complete_date: s.completeDate ?? null,
          // Sprints inherit the squad the board is mapped to.
          squad_id: dbBoard.squadId,
        })),
        'jira_id',
      )
      stats.sprints += sprints.length
    }

    // Reload sprints so we have their database ids and dates for issue linking.
    const { data: sprintRows } = await ctx.db
      .from('jira_sprints')
      .select('id, jira_id, start_date, complete_date')
    for (const row of (sprintRows ?? []) as {
      id: string
      jira_id: string
      start_date: string | null
      complete_date: string | null
    }[]) {
      sprintsByJiraId.set(row.jira_id, {
        id: row.id,
        startDate: row.start_date,
        completeDate: row.complete_date,
      })
    }

    // --- issues ---------------------------------------------------------------

    const statusCategories = await client.statusCategories()
    ctx.log(`Loaded ${statusCategories.size} status definitions`)

    const cursorKey = `issues:${env.projectKeys.join('+')}`

    // A backfill honours a stored cursor too, which ctx.since() deliberately does not.
    // The issue walk is forward and ordered `updated ASC`, so resuming from the cursor
    // cannot skip anything — and without it a backfill restarts at the window start on
    // every run. That is not theoretical: with roughly 560 issues each costing an upsert
    // plus a changelog fetch, a full pass does not fit in one time budget, so eight
    // consecutive runs each spent their whole 270s re-processing the same issues and the
    // walk never advanced by one.
    const storedCursor = await ctx.getCursor(cursorKey)
    const since =
      mode === 'backfill' && storedCursor
        ? new Date(new Date(storedCursor).getTime() - 30 * 60_000).toISOString()
        : await ctx.since(cursorKey, backfillMonths)

    const jql = buildIssueJql(env.projectKeys, since)
    ctx.log(`Searching issues: ${jql}`)

    const issues = await client.searchIssues(jql)
    ctx.log(`Jira returned ${issues.length} issues`)

    const processedIssueIds: string[] = []
    // The `updated` timestamp of the last issue actually written, which is where the next
    // run has to resume from when this one stops early.
    let lastUpdatedProcessed: string | null = null

    for (const issue of issues) {
      if (ctx.outOfTime) {
        stats.ran_out_of_time = 1
        ctx.log(`Stopping after ${stats.issues} issues (out of time)`)
        break
      }

      const assigneeId = issue.fields.assignee
        ? await identities.resolve({
            provider: 'jira',
            externalId: issue.fields.assignee.accountId,
            handle: issue.fields.assignee.displayName,
            displayName: issue.fields.assignee.displayName,
            email: issue.fields.assignee.emailAddress ?? null,
          })
        : null

      const reporterId = issue.fields.reporter
        ? await identities.resolve({
            provider: 'jira',
            externalId: issue.fields.reporter.accountId,
            handle: issue.fields.reporter.displayName,
            displayName: issue.fields.reporter.displayName,
            email: issue.fields.reporter.emailAddress ?? null,
          })
        : null

      const attachedSprints = client.issueSprints(issue)
      const currentSprintJiraId = attachedSprints.at(-1)?.id
      const currentSprint = currentSprintJiraId
        ? sprintsByJiraId.get(String(currentSprintJiraId))
        : undefined

      const issueType = issue.fields.issuetype?.name ?? null
      const isBug = Boolean(issueType && /bug|defect|incident/i.test(issueType))

      const { data: upserted, error } = await ctx.db
        .from('jira_issues')
        .upsert(
          {
            jira_id: issue.id,
            key: issue.key,
            project_key: issue.fields.project?.key ?? issue.key.split('-')[0],
            issue_type: issueType,
            status: issue.fields.status?.name ?? null,
            status_category: issue.fields.status?.statusCategory?.name ?? null,
            resolution: issue.fields.resolution?.name ?? null,
            priority: issue.fields.priority?.name ?? null,
            summary: issue.fields.summary,
            story_points: client.storyPoints(issue),
            assignee_engineer_id: assigneeId,
            assignee_jira_id: issue.fields.assignee?.accountId ?? null,
            reporter_engineer_id: reporterId,
            reporter_jira_id: issue.fields.reporter?.accountId ?? null,
            created_at: issue.fields.created,
            updated_at_remote: issue.fields.updated,
            resolved_at: issue.fields.resolutiondate,
            due_date: issue.fields.duedate,
            parent_key: issue.fields.parent?.key ?? null,
            epic_key: issue.fields.parent?.key ?? null,
            labels: issue.fields.labels ?? [],
            components: (issue.fields.components ?? []).map((c) => c.name),
            current_sprint_id: currentSprint?.id ?? null,
            is_bug: isBug,
            is_production_bug: looksLikeProductionBug(issue),
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'jira_id' },
        )
        .select('id')
        .single()

      if (error) throw new Error(`Issue ${issue.key}: ${error.message}`)
      const issueId = (upserted as { id: string }).id
      processedIssueIds.push(issueId)
      stats.issues += 1
      // Recorded after the write, so a cursor never claims an issue that was not stored.
      if (issue.fields.updated) lastUpdatedProcessed = issue.fields.updated

      // --- status transitions -------------------------------------------------

      const transitions = extractStatusTransitions(issue, statusCategories)
      if (transitions.length > 0) {
        const rows: Record<string, unknown>[] = []
        for (const t of transitions) {
          const authorId = t.authorAccountId
            ? await identities.resolve({
                provider: 'jira',
                externalId: t.authorAccountId,
                displayName: t.authorName,
                email: t.authorEmail,
              })
            : null
          rows.push({
            issue_id: issueId,
            jira_history_id: t.historyId,
            from_status: t.fromStatus,
            to_status: t.toStatus,
            from_category: t.fromCategory,
            to_category: t.toCategory,
            author_engineer_id: authorId,
            author_jira_id: t.authorAccountId,
            created_at: t.createdAt,
          })
        }
        stats.transitions += await upsertInChunks(
          ctx.db,
          'jira_status_transitions',
          rows,
          'issue_id,jira_history_id',
        )
      }

      // --- sprint membership --------------------------------------------------

      const memberships = buildSprintMemberships(
        issue,
        attachedSprints.map((s) => String(s.id)),
        sprintsByJiraId,
      )
      if (memberships.length > 0) {
        stats.issue_sprint_links += await upsertInChunks(
          ctx.db,
          'jira_issue_sprints',
          memberships.map((m) => ({
            issue_id: issueId,
            sprint_id: m.sprintId,
            added_at: m.addedAt,
            added_after_start: m.addedAfterStart,
            completed_in_sprint: m.completedInSprint,
          })),
          'issue_id,sprint_id',
        )
      }
    }

    // Derive first_in_progress_at from the transitions we just wrote.
    if (processedIssueIds.length > 0) {
      const { data: recomputed } = await ctx.db.rpc('recompute_issue_cycle_starts', {
        p_issue_ids: processedIssueIds,
      })
      ctx.log(`Set cycle start on ${recomputed ?? 0} issues`)
    }

    stats.unmatched_identities = await identities.flushUnmatched()

    const { data: linked } = await ctx.db.rpc('link_mrs_to_issues')
    ctx.log(`Linked ${linked ?? 0} merge-request/issue pairs`)

    // Same rule as the GitLab walks, and the same reason: a forward walk may only jump
    // its cursor to now() when nothing was left behind. A run that stopped early has to
    // resume from the last issue it actually wrote, or its work is repeated forever.
    const advance = planCursorAdvance({
      direction: 'forward',
      lastProcessed: lastUpdatedProcessed,
      truncated: issues.length >= JIRA_ISSUE_PAGE_CAP,
      processedWholeBatch: stats.ran_out_of_time === 0,
    })
    if (advance.forwardCursor) {
      await ctx.setCursor(cursorKey, advance.forwardCursor)
    }
    stats.backfill_complete = advance.reachedWindowStart ? 1 : 0

    const status = stats.ran_out_of_time === 1 ? 'partial' : 'success'
    await ctx.finish(status, stats)
    return stats
  } catch (error) {
    await ctx.finish('error', stats, error)
    throw error
  }
}

interface BoardRef {
  id: string
  squadId: string | null
  isTracked: boolean
}

/**
 * Board-name substrings that mark a board as one person's view rather than a team's.
 * In app_settings so a new naming habit does not need a deploy.
 */
async function loadIgnoredBoardPatterns(ctx: SyncContext): Promise<string[]> {
  const { data } = await ctx.db
    .from('app_settings')
    .select('value')
    .eq('key', 'jira_ignored_board_patterns')
    .maybeSingle()
  const value = (data as { value: unknown } | null)?.value
  const patterns = Array.isArray(value) ? (value as string[]) : ["personal board", "'s board"]
  return patterns.map((p) => p.toLowerCase()).filter((p) => p.length > 0)
}

async function loadBoardIds(ctx: SyncContext): Promise<Map<string, BoardRef>> {
  const { data, error } = await ctx.db
    .from('jira_boards')
    .select('id, jira_id, squad_id, is_tracked')
  if (error) throw new Error(`Failed to load boards: ${error.message}`)

  const map = new Map<string, BoardRef>()
  for (const row of (data ?? []) as {
    id: string
    jira_id: string
    squad_id: string | null
    is_tracked: boolean
  }[]) {
    map.set(row.jira_id, { id: row.id, squadId: row.squad_id, isTracked: row.is_tracked })
  }
  return map
}

/**
 * Issues touched since the cursor. updatedDate rather than createdDate so a
 * ticket opened last quarter but finished this week is picked up.
 */
function buildIssueJql(projectKeys: string[], since: string): string {
  const keys = projectKeys.map((k) => `"${k}"`).join(', ')
  // JQL wants "yyyy/MM/dd HH:mm", not ISO 8601.
  const d = new Date(since)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return `project in (${keys}) AND updated >= "${stamp}" ORDER BY updated ASC`
}

interface ExtractedTransition {
  historyId: string
  fromStatus: string | null
  toStatus: string | null
  fromCategory: string | null
  toCategory: string | null
  authorAccountId: string | null
  authorName: string | null
  authorEmail: string | null
  createdAt: string
}

function extractStatusTransitions(
  issue: JiraIssue,
  statusCategories: Map<string, string>,
): ExtractedTransition[] {
  const out: ExtractedTransition[] = []
  const histories: JiraChangelogEntry[] = issue.changelog?.histories ?? []

  for (const entry of histories) {
    for (const item of entry.items ?? []) {
      if (item.field?.toLowerCase() !== 'status') continue
      out.push({
        historyId: entry.id,
        fromStatus: item.fromString,
        toStatus: item.toString,
        fromCategory: item.fromString
          ? statusCategories.get(item.fromString.toLowerCase()) ?? null
          : null,
        toCategory: item.toString
          ? statusCategories.get(item.toString.toLowerCase()) ?? null
          : null,
        authorAccountId: entry.author?.accountId ?? null,
        authorName: entry.author?.displayName ?? null,
        authorEmail: entry.author?.emailAddress ?? null,
        createdAt: entry.created,
      })
    }
  }
  return out
}

interface SprintMembership {
  sprintId: string
  addedAt: string | null
  addedAfterStart: boolean
  completedInSprint: boolean
}

/**
 * Reconstruct which sprints an issue belonged to and when it joined each.
 *
 * The Sprint changelog field stores comma-separated sprint ids, so an entry
 * where an id appears in `to` but not `from` is the moment the issue joined that
 * sprint. Issues attached to a sprint before it started count as committed;
 * anything added after the start date is scope creep.
 */
function buildSprintMemberships(
  issue: JiraIssue,
  currentSprintJiraIds: string[],
  sprintsByJiraId: Map<string, { id: string; startDate: string | null; completeDate: string | null }>,
): SprintMembership[] {
  const addedAtByJiraId = new Map<string, string>()

  for (const entry of issue.changelog?.histories ?? []) {
    for (const item of entry.items ?? []) {
      if (item.field?.toLowerCase() !== 'sprint') continue
      const before = new Set((item.from ?? '').split(',').map((s) => s.trim()).filter(Boolean))
      const after = (item.to ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      for (const sprintId of after) {
        if (!before.has(sprintId) && !addedAtByJiraId.has(sprintId)) {
          addedAtByJiraId.set(sprintId, entry.created)
        }
      }
    }
  }

  // Union of sprints from the changelog and the sprints currently attached — the
  // changelog can be truncated, and the field alone loses history.
  const allSprintJiraIds = new Set([...addedAtByJiraId.keys(), ...currentSprintJiraIds])
  const resolvedAt = issue.fields.resolutiondate

  const out: SprintMembership[] = []
  for (const jiraId of allSprintJiraIds) {
    const sprint = sprintsByJiraId.get(jiraId)
    if (!sprint) continue

    const addedAt = addedAtByJiraId.get(jiraId) ?? sprint.startDate ?? null
    const addedAfterStart = Boolean(
      addedAt && sprint.startDate && new Date(addedAt) > new Date(sprint.startDate),
    )

    // Completed in this sprint means resolved between its start and its close.
    // An open sprint has no complete_date, so anything resolved after it started
    // counts until it closes.
    const completedInSprint = Boolean(
      resolvedAt &&
        sprint.startDate &&
        new Date(resolvedAt) >= new Date(sprint.startDate) &&
        (!sprint.completeDate || new Date(resolvedAt) <= new Date(sprint.completeDate)),
    )

    out.push({ sprintId: sprint.id, addedAt, addedAfterStart, completedInSprint })
  }
  return out
}
