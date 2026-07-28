import { appEnv, gitlabEnv, jiraEnv } from '@/lib/env'
import {
  extractJiraKeys,
  GitLabClient,
  EVENT_PAGE_LIMIT,
  isDraft,
  MR_PAGE_LIMIT,
  type GitLabProject,
  type GitLabUser,
} from '@/lib/integrations/gitlab'
import { IdentityResolver } from '@/lib/sync/identity'
import {
  mapLimit,
  SyncContext,
  upsertInChunks,
  type SyncMode,
  type SyncTrigger,
} from '@/lib/sync/runner'

/**
 * GitLab sync. Walks tracked projects and pulls merge requests, review notes,
 * commits, deployments and pipelines.
 *
 * Resumability is the important property here. A single merge request costs four
 * API calls (detail, commits, notes, approvals), so a twelve-month backfill of a
 * real org cannot finish inside one serverless invocation. Runs stop cleanly on a
 * time budget, report 'partial', and resume from their cursors.
 *
 * There are two directions, with a cursor each:
 *  - 'backfill' walks newest-first towards the past, so the dashboard is useful
 *    immediately and older history fills in behind it. Its frontier lives in
 *    `:oldest` and moves backwards.
 *  - 'incremental' walks forward from the high-water-mark cursor to keep the
 *    recent end current.
 * Both matter because the listing is truncated at a page limit: whichever end the
 * sort drops has to be the end the cursor will resume from, or those merge
 * requests are never fetched again.
 */
export async function syncGitLab(
  mode: SyncMode = 'incremental',
  trigger: SyncTrigger = 'manual',
  options: { projectLimit?: number; budgetMs?: number } = {},
) {
  const ctx = new SyncContext('gitlab', mode, trigger, options.budgetMs)
  await ctx.start()

  const stats = {
    projects: 0,
    projects_completed: 0,
    merge_requests: 0,
    notes: 0,
    commits: 0,
    deployments: 0,
    pipelines: 0,
    unmatched_identities: 0,
    project_errors: 0,
    /** Slices cut short by a per-merge-request failure; the next run retries them. */
    mr_errors: 0,
    ran_out_of_time: 0,
    /**
     * Set once every project's backward pass has reached the start of the window.
     * ran_out_of_time alone cannot say this: a backward run can finish its slice
     * with time to spare and still have years of history left to walk.
     */
    backfill_complete: 0,
  }

  try {
    const client = new GitLabClient()
    const env = gitlabEnv()
    const backfillMonths = appEnv().backfillMonths
    const jiraKeys = jiraEnv().projectKeys

    const identities = new IdentityResolver(ctx.db)
    await identities.load()

    ctx.log('Discovering projects')
    const projects = await discoverProjects(ctx, client, env.groups, env.projects)
    const tracked = options.projectLimit ? projects.slice(0, options.projectLimit) : projects
    stats.projects = tracked.length
    ctx.log(`Syncing ${tracked.length} tracked projects`)

    const productionPatterns = await loadProductionPatterns(ctx)
    let backfillDone = 0

    // Four at a time: fast enough for a backfill, gentle enough that GitLab does
    // not start returning 429s.
    const { errors } = await mapLimit(tracked, 4, async (project) => {
      if (ctx.outOfTime) {
        stats.ran_out_of_time = 1
        return
      }

      const counts = await syncProject(ctx, client, identities, project, {
        backfillMonths,
        jiraKeys,
        productionPatterns,
      })

      stats.merge_requests += counts.mergeRequests
      stats.notes += counts.notes
      stats.commits += counts.commits
      stats.deployments += counts.deployments
      stats.pipelines += counts.pipelines
      if (counts.completed) stats.projects_completed += 1
      else stats.ran_out_of_time = 1
      if (counts.backfillComplete) backfillDone += 1
      if (counts.stoppedOnError) stats.mr_errors += 1
    })

    // Only meaningful when every project reported reaching the window start.
    if (mode === 'backfill' && tracked.length > 0 && backfillDone === tracked.length) {
      stats.backfill_complete = 1
    }

    for (const { item, error } of errors) {
      stats.project_errors += 1
      ctx.log(`Project ${item.path_with_namespace} failed: ${error.message}`)
    }

    stats.unmatched_identities = await identities.flushUnmatched()

    // Now that MRs exist, connect them to any Jira issues already synced.
    const { data: linked } = await ctx.db.rpc('link_mrs_to_issues')
    ctx.log(`Linked ${linked ?? 0} merge-request/issue pairs`)

    const status =
      stats.project_errors > 0 || stats.ran_out_of_time === 1 ? 'partial' : 'success'
    if (stats.ran_out_of_time === 1) {
      ctx.log('Time budget exhausted — run again to continue from the stored cursors')
    }
    await ctx.finish(status, stats)
    return stats
  } catch (error) {
    await ctx.finish('error', stats, error)
    throw error
  }
}

interface TrackedProject {
  id: string
  gitlab_id: number
  path_with_namespace: string
  default_branch: string | null
}

/**
 * Upsert the project list from the configured groups and explicit paths, then
 * return the ones marked as tracked. Projects can be untracked in the admin
 * screen to keep them out of future syncs.
 */
async function discoverProjects(
  ctx: SyncContext,
  client: GitLabClient,
  groups: string[],
  explicit: string[],
): Promise<TrackedProject[]> {
  const discovered = new Map<number, GitLabProject>()

  for (const group of groups) {
    const projects = await client.groupProjects(group)
    for (const p of projects) discovered.set(p.id, p)
    ctx.log(`Group ${group}: ${projects.length} projects`)
  }

  for (const ref of explicit) {
    const project = await client.project(ref)
    discovered.set(project.id, project)
  }

  if (discovered.size > 0) {
    await upsertInChunks(
      ctx.db,
      'gitlab_projects',
      Array.from(discovered.values()).map((p) => ({
        gitlab_id: p.id,
        name: p.name,
        path_with_namespace: p.path_with_namespace,
        web_url: p.web_url,
        default_branch: p.default_branch,
        archived: p.archived,
        last_activity_at: p.last_activity_at,
      })),
      'gitlab_id',
    )
  }

  const { data, error } = await ctx.db
    .from('gitlab_projects')
    .select('id, gitlab_id, path_with_namespace, default_branch')
    .eq('is_tracked', true)
    .eq('archived', false)
  if (error) throw new Error(`Failed to load tracked projects: ${error.message}`)
  return (data ?? []) as TrackedProject[]
}

/**
 * Window for a deployment or pipeline listing, in whichever direction the run is
 * walking. Mirrors what syncProject does for merge requests, because these streams
 * have exactly the same truncation problem and need exactly the same treatment:
 * a busy project produces far more deployments than merge requests, so the page
 * limit is reached sooner, not later.
 */
async function eventWindow(
  ctx: SyncContext,
  backwards: boolean,
  windowStart: Date,
  forwardKey: string,
  backfillKey: string,
  backfillMonths: number,
): Promise<{ since: string; updatedBefore: string | undefined }> {
  if (!backwards) {
    return { since: await ctx.since(forwardKey, backfillMonths), updatedBefore: undefined }
  }
  // Claim the present for the forward cursor on the first backward pass, so
  // incremental runs keep the recent end fresh while the past is still being walked.
  if (!(await ctx.getCursor(forwardKey))) {
    await ctx.setCursor(forwardKey, new Date().toISOString())
  }
  return {
    since: windowStart.toISOString(),
    updatedBefore: (await ctx.getCursor(backfillKey)) ?? undefined,
  }
}

/**
 * Move the cursor after a listing.
 *
 * The forward cursor may only jump to "now" when the result was NOT truncated.
 * Doing it unconditionally — which is what used to happen here — meant a truncated
 * fetch declared everything up to the present as captured, and the records beyond
 * the cut were never requested again. That is why every deployment in the database
 * came from a single day.
 */
async function advanceEventCursor(
  ctx: SyncContext,
  backwards: boolean,
  forwardKey: string,
  backfillKey: string,
  /**
   * updated_at of the last record processed. The list is sorted in the direction of
   * travel, so this is the oldest one on a backward pass and the newest on a forward
   * one — either way it is the point the next run should resume from.
   */
  lastProcessed: string | null,
  truncated: boolean,
): Promise<void> {
  if (backwards) {
    if (lastProcessed) await ctx.setCursor(backfillKey, lastProcessed)
    return
  }
  if (!truncated) {
    await ctx.setCursor(forwardKey, new Date().toISOString())
  } else if (lastProcessed) {
    await ctx.setCursor(forwardKey, lastProcessed)
  }
}

async function loadProductionPatterns(ctx: SyncContext): Promise<string[]> {
  const { data } = await ctx.db
    .from('app_settings')
    .select('value')
    .eq('key', 'production_environment_patterns')
    .maybeSingle()
  const value = (data as { value: unknown } | null)?.value
  return Array.isArray(value) ? (value as string[]) : ['production', 'prod', 'live']
}

/**
 * Whether a GitLab environment is production.
 *
 * A plain substring test is not enough: this org has environments called
 * `nonprod-grafana-alloy-testing-*`, and "nonprod" contains "prod". Those were
 * being flagged as production, and were staying out of the DORA numbers only
 * because none had reached a terminal status yet — the first successful one would
 * have quietly inflated deploy frequency and skewed change failure rate and MTTR.
 *
 * So the match has to start on a word boundary. `prod-client-x` and
 * `p4h-prod-server-x` qualify; `nonprod-x` does not. A pattern followed by more
 * letters is still fine — "production" is production.
 */
function isProductionEnvironment(name: string, patterns: string[]): boolean {
  const n = name.toLowerCase()
  return patterns.some((pattern) => {
    const needle = pattern.toLowerCase()
    if (needle.length === 0) return false
    for (let from = 0; ; ) {
      const idx = n.indexOf(needle, from)
      if (idx === -1) return false
      const precededByLetter = idx > 0 && /[a-z]/.test(n[idx - 1])
      // "non" immediately before the match negates it, whether or not a separator
      // sits between them: nonprod, non-prod and non_prod all mean the same thing.
      const negated = /(^|[-_./])non$/.test(n.slice(0, idx).replace(/[-_./]$/, ''))
      if (!precededByLetter && !negated) return true
      from = idx + 1
    }
  })
}

async function syncProject(
  ctx: SyncContext,
  client: GitLabClient,
  identities: IdentityResolver,
  project: TrackedProject,
  config: { backfillMonths: number; jiraKeys: string[]; productionPatterns: string[] },
) {
  const counts = {
    mergeRequests: 0,
    notes: 0,
    commits: 0,
    deployments: 0,
    pipelines: 0,
    completed: false,
    backfillComplete: false,
    stoppedOnError: null as string | null,
  }

  const mrCursorKey = `project:${project.gitlab_id}:merge_requests`
  // Separate frontier for the backward pass. The forward cursor is a high-water
  // mark and only ever moves forward, so it cannot also describe how far back a
  // backfill has reached; conflating the two is what silently loses history.
  const backfillCursorKey = `project:${project.gitlab_id}:merge_requests:oldest`

  const backwards = ctx.mode === 'backfill'
  const windowStart = new Date()
  windowStart.setMonth(windowStart.getMonth() - config.backfillMonths)

  let since: string
  let updatedBefore: string | undefined

  if (backwards) {
    // Newest first, walking towards the past. The frontier is where the previous
    // backward run stopped; unset means start from now.
    since = windowStart.toISOString()
    updatedBefore = (await ctx.getCursor(backfillCursorKey)) ?? undefined
    // Claim everything from this moment on for the forward cursor, so ordinary
    // incremental runs keep the recent end fresh while the backward pass is still
    // working through the older history.
    if (!(await ctx.getCursor(mrCursorKey))) {
      await ctx.setCursor(mrCursorKey, new Date().toISOString())
    }
  } else {
    since = await ctx.since(mrCursorKey, config.backfillMonths)
  }

  const list = await client.mergeRequests(project.gitlab_id, since, {
    updatedBefore,
    sort: backwards ? 'desc' : 'asc',
  })
  // Process in the direction we are walking, so the cursor written mid-run always
  // describes a contiguous span rather than an arbitrary subset.
  list.sort((a, b) =>
    backwards ? b.updated_at.localeCompare(a.updated_at) : a.updated_at.localeCompare(b.updated_at),
  )
  const truncated = list.length >= MR_PAGE_LIMIT
  ctx.log(
    backwards
      ? `${project.path_with_namespace}: ${list.length} merge requests updated before ${updatedBefore ?? 'now'} (walking back to ${since})${truncated ? ' [truncated at page limit]' : ''}`
      : `${project.path_with_namespace}: ${list.length} merge requests changed since ${since}`,
  )

  const processedMrIds: string[] = []

  for (const summary of list) {
    if (ctx.outOfTime) {
      ctx.log(`${project.path_with_namespace}: stopping after ${counts.mergeRequests} MRs (out of time)`)
      break
    }

    // One merge request failing must not discard the slice: everything written so
    // far is real, and the cursor still points at the last one that succeeded.
    // Ending the slice here rather than skipping ahead keeps the walk contiguous —
    // skipping would put this merge request permanently behind the frontier — and
    // the next run simply retries it.
    let mr
    try {
      // The list view omits diff_stats, so the MR is fetched individually.
      mr = await client.mergeRequest(project.gitlab_id, summary.iid)
    } catch (error) {
      counts.stoppedOnError = `!${summary.iid}: ${error instanceof Error ? error.message : String(error)}`
      ctx.log(
        `${project.path_with_namespace}: stopping after ${counts.mergeRequests} MRs — ${counts.stoppedOnError}`,
      )
      break
    }

    const authorEngineerId = mr.author
      ? await identities.resolve({
          provider: 'gitlab',
          externalId: String(mr.author.id),
          handle: mr.author.username,
          displayName: mr.author.name,
          email: gitlabEmail(mr.author),
        })
      : null

    const merger = mr.merge_user ?? mr.merged_by ?? null
    const mergedByEngineerId = merger
      ? await identities.resolve({
          provider: 'gitlab',
          externalId: String(merger.id),
          handle: merger.username,
          displayName: merger.name,
          email: gitlabEmail(merger),
        })
      : null

    const commits = await client.mergeRequestCommits(project.gitlab_id, mr.iid)
    const firstCommitAt = commits.length
      ? commits.map((c) => c.authored_date).sort()[0]
      : null

    const approvals = await client.mergeRequestApprovals(project.gitlab_id, mr.iid)

    const { data: upserted, error } = await ctx.db
      .from('merge_requests')
      .upsert(
        {
          gitlab_id: mr.id,
          iid: mr.iid,
          project_id: project.id,
          title: mr.title,
          description_length: mr.description?.length ?? 0,
          state: mr.state,
          is_draft: isDraft(mr),
          source_branch: mr.source_branch,
          target_branch: mr.target_branch,
          web_url: mr.web_url,
          author_engineer_id: authorEngineerId,
          author_gitlab_id: mr.author ? String(mr.author.id) : null,
          merged_by_engineer_id: mergedByEngineerId,
          opened_at: mr.created_at,
          updated_at_remote: mr.updated_at,
          merged_at: mr.merged_at,
          closed_at: mr.closed_at,
          first_commit_at: firstCommitAt,
          additions: mr.diff_stats?.additions ?? 0,
          deletions: mr.diff_stats?.deletions ?? 0,
          changed_files: mr.diff_stats?.file_count ?? 0,
          commits_count: commits.length,
          approvals_count: approvals?.approved_by?.length ?? 0,
          labels: mr.labels ?? [],
          jira_keys: extractJiraKeys(mr, config.jiraKeys),
          synced_at: new Date().toISOString(),
        },
        { onConflict: 'gitlab_id' },
      )
      .select('id')
      .single()

    if (error) throw new Error(`MR ${project.path_with_namespace}!${mr.iid}: ${error.message}`)
    const mrId = (upserted as { id: string }).id
    processedMrIds.push(mrId)
    counts.mergeRequests += 1

    // --- review notes ---------------------------------------------------------

    const notes = await client.mergeRequestNotes(project.gitlab_id, mr.iid)
    const noteRows: Record<string, unknown>[] = []

    for (const note of notes) {
      // System notes are state changes ("assigned to…"), not review signal —
      // except approvals, which GitLab records as system notes.
      const approvalNote = note.system && /^approved this merge request/i.test(note.body)
      const unapprovalNote = note.system && /^unapproved this merge request/i.test(note.body)
      if (note.system && !approvalNote && !unapprovalNote) continue

      const reviewerId = note.author
        ? await identities.resolve({
            provider: 'gitlab',
            externalId: String(note.author.id),
            handle: note.author.username,
            displayName: note.author.name,
            email: gitlabEmail(note.author),
          })
        : null

      noteRows.push({
        gitlab_id: note.id,
        merge_request_id: mrId,
        author_engineer_id: reviewerId,
        author_gitlab_id: note.author ? String(note.author.id) : null,
        kind: approvalNote ? 'approval' : unapprovalNote ? 'unapproval' : 'comment',
        body_length: note.body?.length ?? 0,
        is_resolvable: note.resolvable ?? false,
        resolved: note.resolved ?? false,
        created_at: note.created_at,
      })
    }

    if (noteRows.length > 0) {
      counts.notes += await upsertInChunks(ctx.db, 'merge_request_notes', noteRows, 'gitlab_id')
    }

    // --- commits on the MR ----------------------------------------------------

    const commitRows: Record<string, unknown>[] = []
    for (const commit of commits) {
      const authorEngineer = await resolveCommitAuthor(identities, commit.author_email)
      commitRows.push({
        sha: commit.id,
        project_id: project.id,
        merge_request_id: mrId,
        author_engineer_id: authorEngineer,
        author_email: commit.author_email,
        author_name: commit.author_name,
        title: commit.title,
        authored_at: commit.authored_date,
        committed_at: commit.committed_date,
        additions: commit.stats?.additions ?? 0,
        deletions: commit.stats?.deletions ?? 0,
        is_merge_commit: (commit.parent_ids?.length ?? 0) > 1,
      })
    }
    if (commitRows.length > 0) {
      counts.commits += await upsertInChunks(ctx.db, 'gitlab_commits', commitRows, 'project_id,sha')
    }

    // Advance the cursor per MR so an interrupted run resumes precisely. Written
    // every few MRs rather than every one to keep the write volume sane.
    if (counts.mergeRequests % 5 === 0) {
      await ctx.setCursor(backwards ? backfillCursorKey : mrCursorKey, mr.updated_at)
    }
  }

  const lastProcessed = list[counts.mergeRequests - 1]
  const finishedAllMrs = counts.mergeRequests === list.length

  if (backwards) {
    if (lastProcessed) {
      // Oldest one reached this run becomes the next run's ceiling.
      await ctx.setCursor(backfillCursorKey, lastProcessed.updated_at)
    }
    // Only a short result proves we reached the window start; a full page-limit
    // result means there is more history beyond the truncation.
    if (finishedAllMrs && !truncated) {
      counts.backfillComplete = true
      ctx.log(`${project.path_with_namespace}: reached the start of the ${config.backfillMonths}-month window`)
    }
  } else if (finishedAllMrs) {
    // Everything up to now is captured; the small overlap in since() covers any
    // event written while this run was in flight.
    await ctx.setCursor(mrCursorKey, new Date().toISOString())
  } else if (lastProcessed) {
    await ctx.setCursor(mrCursorKey, lastProcessed.updated_at)
  }

  // Derive first_review_at / distinct_reviewers now that notes are written.
  if (processedMrIds.length > 0) {
    await ctx.db.rpc('recompute_mr_review_stats', { p_mr_ids: processedMrIds })
  }

  if (!finishedAllMrs) return counts

  // --- deployments ------------------------------------------------------------

  const deployCursorKey = `project:${project.gitlab_id}:deployments`
  const deployBackfillKey = `${deployCursorKey}:oldest`
  const deployWindow = await eventWindow(ctx, backwards, windowStart, deployCursorKey, deployBackfillKey, config.backfillMonths)
  const deployments = await client.deployments(project.gitlab_id, deployWindow.since, {
    updatedBefore: deployWindow.updatedBefore,
    sort: backwards ? 'desc' : 'asc',
  })
  deployments.sort((a, b) =>
    backwards ? b.updated_at.localeCompare(a.updated_at) : a.updated_at.localeCompare(b.updated_at),
  )
  const deploysTruncated = deployments.length >= EVENT_PAGE_LIMIT
  ctx.log(
    `${project.path_with_namespace}: ${deployments.length} deployments${backwards ? ` updated before ${deployWindow.updatedBefore ?? 'now'}` : ` since ${deployWindow.since}`}${deploysTruncated ? ' [truncated at page limit]' : ''}`,
  )
  const deploymentRows: Record<string, unknown>[] = []

  for (const deployment of deployments) {
    const environment = deployment.environment?.name ?? 'unknown'
    const user = deployment.user ?? deployment.deployable?.user ?? null
    const engineerId = user
      ? await identities.resolve({
          provider: 'gitlab',
          externalId: String(user.id),
          handle: user.username,
          displayName: user.name,
          email: gitlabEmail(user),
        })
      : null

    deploymentRows.push({
      gitlab_id: deployment.id,
      project_id: project.id,
      iid: deployment.iid,
      environment,
      is_production: isProductionEnvironment(environment, config.productionPatterns),
      status: deployment.status,
      ref: deployment.ref,
      sha: deployment.sha,
      deployed_by_engineer_id: engineerId,
      deployed_by_gitlab_id: user ? String(user.id) : null,
      created_at: deployment.created_at,
      finished_at: deployment.deployable?.finished_at ?? deployment.updated_at,
    })
  }
  if (deploymentRows.length > 0) {
    // Only production deployments are stored. Every consumer — deploy frequency,
    // change failure rate, MTTR — reads v_prod_deployments, which filters on
    // is_production, so the qa/staging/testing/e2e environments are dead weight:
    // they are about 96% of the volume here, and keeping them would mean ~650,000
    // rows to serve ~26,000 useful ones. If a non-production metric is ever wanted,
    // this filter is the thing to relax, and it needs a re-sync to backfill them.
    const productionRows = deploymentRows.filter((row) => row.is_production === true)
    counts.deployments += await upsertInChunks(
      ctx.db,
      'gitlab_deployments',
      productionRows,
      'project_id,gitlab_id',
    )
  }
  await advanceEventCursor(
    ctx,
    backwards,
    deployCursorKey,
    deployBackfillKey,
    deployments.at(-1)?.updated_at ?? null,
    deploysTruncated,
  )

  // --- pipelines --------------------------------------------------------------

  const pipelineCursorKey = `project:${project.gitlab_id}:pipelines`
  const pipelineBackfillKey = `${pipelineCursorKey}:oldest`
  const pipelineWindow = await eventWindow(ctx, backwards, windowStart, pipelineCursorKey, pipelineBackfillKey, config.backfillMonths)
  const pipelines = await client.pipelines(project.gitlab_id, pipelineWindow.since, {
    updatedBefore: pipelineWindow.updatedBefore,
    sort: backwards ? 'desc' : 'asc',
  })
  pipelines.sort((a, b) =>
    backwards ? b.updated_at.localeCompare(a.updated_at) : a.updated_at.localeCompare(b.updated_at),
  )
  const pipelinesTruncated = pipelines.length >= EVENT_PAGE_LIMIT
  const pipelineRows = pipelines.map((p) => ({
    gitlab_id: p.id,
    project_id: project.id,
    ref: p.ref,
    sha: p.sha,
    status: p.status,
    source: p.source,
    is_default_branch: Boolean(project.default_branch && p.ref === project.default_branch),
    created_at: p.created_at,
    started_at: p.started_at ?? null,
    finished_at: p.finished_at ?? null,
    duration_s: p.duration ?? null,
  }))
  if (pipelineRows.length > 0) {
    counts.pipelines += await upsertInChunks(ctx.db, 'gitlab_pipelines', pipelineRows, 'gitlab_id')
  }
  await advanceEventCursor(
    ctx,
    backwards,
    pipelineCursorKey,
    pipelineBackfillKey,
    pipelines.at(-1)?.updated_at ?? null,
    pipelinesTruncated,
  )

  // The window is only fully covered when every stream has reached its start.
  // Merge requests finishing first says nothing about deployments, which are far
  // more numerous and hit the page limit sooner.
  if (backwards && (deploysTruncated || pipelinesTruncated)) {
    counts.backfillComplete = false
  }

  counts.completed = true
  return counts
}

/** GitLab only exposes an email on some tiers/endpoints; both fields are tried. */
function gitlabEmail(user: GitLabUser): string | null {
  return user.email ?? user.public_email ?? null
}

/**
 * Commits carry a git author email rather than a GitLab user id, so they resolve
 * through the email index only. Bot and noreply addresses are skipped outright
 * so they never reach the triage list.
 */
async function resolveCommitAuthor(
  identities: IdentityResolver,
  email: string | null,
): Promise<string | null> {
  if (!email) return null
  if (/noreply|no-reply|\[bot\]|users\.noreply/i.test(email)) return null
  const normalised = email.toLowerCase()
  return identities.resolve({
    provider: 'gitlab',
    // Prefixed so it cannot collide with a numeric GitLab user id.
    externalId: `email:${normalised}`,
    handle: normalised,
    displayName: normalised,
    email: normalised,
  })
}
