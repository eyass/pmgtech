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
import { runCommitBridge } from '@/lib/sync/bridge'
import {
  commitsNeedingStats,
  resolveMrSize,
  type CommitSizeSource,
} from '@/lib/sync/change-size'
import { shapeOfChange } from '@/lib/sync/file-classes'
import { IdentityResolver } from '@/lib/sync/identity'
import { isProductionEnvironment } from '@/lib/sync/matching'
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
    /**
     * Change-size collection. mrs_sized counts merge requests whose line counts were
     * established; commit_stat_calls is what that cost in extra API calls, and is here
     * so the price of the measurement is visible next to the measurement.
     */
    mrs_sized: 0,
    mrs_with_paths: 0,
    commit_stat_calls: 0,
    sizes_backfilled: 0,
    mrs_resized_from_commits: 0,
    /** Commit-bridge outcome: links written, rows re-attributed, cases left for review. */
    bridge_linked: 0,
    bridge_reattributed: 0,
    bridge_suggestions: 0,
    bridge_error: '' as string,
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
      stats.mrs_sized += counts.mrsSized
      stats.mrs_with_paths += counts.mrsWithPaths
      stats.commit_stat_calls += counts.commitStatCalls
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

    // Measure whatever history is still unmeasured, on leftover budget only.
    try {
      const sizes = await backfillChangeSizes(ctx, client)
      stats.sizes_backfilled = sizes.commits
      stats.mrs_resized_from_commits = sizes.mrs
    } catch (error) {
      // Sizes are an enrichment of rows that are already stored, so failing to
      // measure them must not cost the slice everything else fetched.
      ctx.log(`Size backfill failed: ${(error as Error).message}`)
    }

    // Now that MRs exist, connect them to any Jira issues already synced.
    const { data: linked } = await ctx.db.rpc('link_mrs_to_issues')
    ctx.log(`Linked ${linked ?? 0} merge-request/issue pairs`)

    // Most GitLab accounts here expose no email, so email-only resolution leaves nearly
    // half of merged MRs attributed to nobody. The commits inside them do carry emails;
    // the bridge links the account when that evidence is unambiguous and leaves the rest
    // for the admin screen. Runs last so it sees the commits this slice just wrote.
    try {
      const bridge = await runCommitBridge(ctx.db)
      stats.bridge_linked = bridge.linked
      stats.bridge_reattributed = bridge.reattributed
      stats.bridge_suggestions = bridge.candidates.filter(
        (c) => c.verdict.action !== 'link' && c.verdict.action !== 'skip',
      ).length
      for (const row of bridge.candidates) {
        if (row.verdict.action === 'link') {
          ctx.log(`Bridged ${row.handle ?? row.externalId}: ${row.verdict.reason}`)
        }
      }
    } catch (error) {
      // A bridge failure must not lose a slice's worth of fetched data — the links are
      // derived and can be rebuilt on the next run.
      stats.bridge_error = (error as Error).message.slice(0, 200)
      ctx.log(`Commit bridge failed: ${(error as Error).message}`)
    }

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

/**
 * Commit line-count fetches allowed per merge request when the listing did not
 * supply them. Ten covers the 90th percentile here (eleven commits per MR), and the
 * cap is what stops one two-hundred-commit branch from spending a whole run's budget
 * on a single row while every other metric waits.
 */
const MR_COMMIT_STAT_LIMIT = 10

/** Historical commits measured per run, once the walks have had their budget. */
const SIZE_BACKFILL_LIMIT = 400

/**
 * Measure the size of history that was written before sizes were collected.
 *
 * This exists because the merge-request walk never comes back. It advances by
 * `updated_at`, and a merge request that merged in March is never updated again, so
 * without a separate pass the complexity metric would only ever cover work merged
 * after this code shipped — useful in three months, useless now, and silently
 * partial in the meantime.
 *
 * Runs last and only on whatever budget is left, so it can never delay the walks
 * that keep every other metric current. Newest commits first, because a 90-day
 * dashboard is what people actually look at. Resumable by construction: the queue is
 * "rows where size_source is null", so each run simply shortens it.
 */
async function backfillChangeSizes(
  ctx: SyncContext,
  client: GitLabClient,
): Promise<{ commits: number; mrs: number }> {
  if (ctx.outOfTime) return { commits: 0, mrs: 0 }

  const { data, error } = await ctx.db
    .from('gitlab_commits')
    .select('id, sha, project_id, gitlab_projects!inner(gitlab_id)')
    .is('size_source', null)
    .order('authored_at', { ascending: false })
    .limit(SIZE_BACKFILL_LIMIT)
  if (error) {
    ctx.log(`Size backfill could not read its queue: ${error.message}`)
    return { commits: 0, mrs: 0 }
  }

  const queue = (data ?? []) as unknown as {
    id: string
    sha: string
    gitlab_projects: { gitlab_id: number }
  }[]
  if (queue.length === 0) return { commits: 0, mrs: 0 }

  let measured = 0
  for (const row of queue) {
    if (ctx.outOfTime) break
    const stats = await client.commitStats(row.gitlab_projects.gitlab_id, row.sha)
    // A sha that no longer resolves — force-pushed away, or in a repository this
    // token cannot read — is marked 'unavailable' rather than left null, otherwise
    // it heads the queue forever and every run retries the same dead commits.
    const { error: writeError } = await ctx.db
      .from('gitlab_commits')
      .update({
        additions: stats?.additions ?? 0,
        deletions: stats?.deletions ?? 0,
        size_source: stats ? 'commit_api' : 'unavailable',
        size_measured_at: new Date().toISOString(),
      })
      .eq('id', row.id)
    if (writeError) {
      ctx.log(`Size backfill write failed for ${row.sha.slice(0, 8)}: ${writeError.message}`)
      break
    }
    if (stats) measured += 1
  }

  // Merge-request sizes are then derived from the commits that now have one. Done in
  // SQL because it is a set operation over rows this loop did not necessarily touch:
  // a merge request becomes measurable the moment its *last* unmeasured commit is.
  const { data: resized, error: rpcError } = await ctx.db.rpc('resize_mrs_from_commits')
  if (rpcError) ctx.log(`Deriving MR sizes from commits failed: ${rpcError.message}`)

  ctx.log(
    `Size backfill: measured ${measured} of ${queue.length} commits, derived ${resized ?? 0} merge-request sizes`,
  )
  return { commits: measured, mrs: (resized as number | null) ?? 0 }
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
    /** Merge requests whose line counts were established this run. */
    mrsSized: 0,
    /** Extra API calls spent obtaining commit line counts. */
    commitStatCalls: 0,
    /** Merge requests whose file paths were obtained, so authored churn is known. */
    mrsWithPaths: 0,
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

    // Line counts, if the commit listing did not already carry them. This is the
    // only place a size can be established for a merge request, because a merged
    // MR is never revisited by the walk — so skipping it here means the change is
    // never measured. Capped per merge request and abandoned once the run is out
    // of time; whatever is missed queues for the size backfill below.
    const commitSizeSource = new Map<string, CommitSizeSource>()
    for (const commit of commits) {
      if (commit.stats) commitSizeSource.set(commit.id, 'list_stats')
    }
    if (!ctx.outOfTime) {
      for (const commit of commitsNeedingStats(commits, MR_COMMIT_STAT_LIMIT)) {
        if (ctx.outOfTime) break
        const stats = await client.commitStats(project.gitlab_id, commit.id)
        counts.commitStatCalls += 1
        if (stats) {
          commit.stats = stats
          commitSizeSource.set(commit.id, 'commit_api')
        } else {
          commitSizeSource.set(commit.id, 'unavailable')
        }
      }
    }

    // GraphQL first: it is the only source that carries file paths, which is what
    // lets a lockfile bump stop counting as five thousand lines of work. One call,
    // no diff bodies. Falls back to the commit sums above when it answers nothing.
    const graphql = await client.mergeRequestDiffStats(project.path_with_namespace, mr.iid)
    const shape = graphql ? shapeOfChange(graphql.files) : null

    const size = graphql?.summary
      ? {
          additions: graphql.summary.additions,
          deletions: graphql.summary.deletions,
          changedFiles: graphql.summary.fileCount,
          source: 'graphql_diff_stats' as const,
          churnKnown: true,
        }
      : resolveMrSize({
          diffStats: mr.diff_stats,
          changesCount: mr.changes_count,
          commits,
        })
    if (size.churnKnown) counts.mrsSized += 1
    if (shape) counts.mrsWithPaths += 1

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
          additions: size.additions,
          deletions: size.deletions,
          changed_files: size.changedFiles,
          // Recorded so a zero can never again pass for a measurement: the views
          // read churn as NULL unless the source says a line count was obtained.
          size_source: size.source,
          size_measured_at: new Date().toISOString(),
          // Only set where paths were available. Left null otherwise, so the view
          // knows to fall back to total churn rather than assuming nothing was
          // generated.
          churn_authored: shape?.churnAuthored ?? null,
          files_authored: shape?.filesAuthored ?? null,
          modules_touched: shape?.modules ?? null,
          generated_pct: shape?.generatedPct ?? null,
          test_ratio: shape?.testRatio ?? null,
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
        size_source: commitSizeSource.get(commit.id) ?? null,
        size_measured_at: commitSizeSource.has(commit.id) ? new Date().toISOString() : null,
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
    // is_production, so the qa/staging/testing/e2e environments are dead weight.
    // Measured on this org: 20,000 fetched, 7,485 kept, so roughly 60% of the volume.
    // If a non-production metric is ever wanted, this filter is the thing to relax,
    // and it needs a re-sync to backfill what was skipped.
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
