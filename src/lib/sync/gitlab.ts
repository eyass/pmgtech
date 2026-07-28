import { appEnv, gitlabEnv, jiraEnv } from '@/lib/env'
import {
  extractJiraKeys,
  GitLabClient,
  isDraft,
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
 * real org cannot finish inside one serverless invocation. Merge requests are
 * therefore fetched oldest-updated-first and the project cursor is advanced to
 * the last MR actually written — when the time budget runs out mid-project the
 * run reports 'partial' and the next run picks up exactly where it stopped.
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
    ran_out_of_time: 0,
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
    })

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

async function loadProductionPatterns(ctx: SyncContext): Promise<string[]> {
  const { data } = await ctx.db
    .from('app_settings')
    .select('value')
    .eq('key', 'production_environment_patterns')
    .maybeSingle()
  const value = (data as { value: unknown } | null)?.value
  return Array.isArray(value) ? (value as string[]) : ['production', 'prod', 'live']
}

function isProductionEnvironment(name: string, patterns: string[]): boolean {
  const n = name.toLowerCase()
  return patterns.some((p) => n.includes(p.toLowerCase()))
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
  }

  const mrCursorKey = `project:${project.gitlab_id}:merge_requests`
  const since = await ctx.since(mrCursorKey, config.backfillMonths)

  // Ascending order is what makes the cursor meaningful: everything before the
  // last processed MR's updated_at is known to be written.
  const list = await client.mergeRequests(project.gitlab_id, since)
  list.sort((a, b) => a.updated_at.localeCompare(b.updated_at))
  ctx.log(`${project.path_with_namespace}: ${list.length} merge requests changed since ${since}`)

  const processedMrIds: string[] = []

  for (const summary of list) {
    if (ctx.outOfTime) {
      ctx.log(`${project.path_with_namespace}: stopping after ${counts.mergeRequests} MRs (out of time)`)
      break
    }

    // The list view omits diff_stats, so the MR is fetched individually.
    const mr = await client.mergeRequest(project.gitlab_id, summary.iid)

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
      await ctx.setCursor(mrCursorKey, mr.updated_at)
    }
  }

  const lastProcessed = list[counts.mergeRequests - 1]
  const finishedAllMrs = counts.mergeRequests === list.length

  if (finishedAllMrs) {
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
  const deploySince = await ctx.since(deployCursorKey, config.backfillMonths)
  const deployments = await client.deployments(project.gitlab_id, deploySince)
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
    counts.deployments += await upsertInChunks(
      ctx.db,
      'gitlab_deployments',
      deploymentRows,
      'project_id,gitlab_id',
    )
  }
  await ctx.setCursor(deployCursorKey, new Date().toISOString())

  // --- pipelines --------------------------------------------------------------

  const pipelineCursorKey = `project:${project.gitlab_id}:pipelines`
  const pipelineSince = await ctx.since(pipelineCursorKey, config.backfillMonths)
  const pipelines = await client.pipelines(project.gitlab_id, pipelineSince)
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
  await ctx.setCursor(pipelineCursorKey, new Date().toISOString())

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
