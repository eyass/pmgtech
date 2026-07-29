import { gitlabEnv } from '@/lib/env'
import { IntegrationError, requestJson } from '@/lib/integrations/http'

/**
 * Minimal GitLab REST v4 client covering exactly what the tracker needs.
 * Works against gitlab.com and self-managed instances — the host comes from
 * GITLAB_HOST and no SaaS-only endpoints are used.
 */

export interface GitLabUser {
  id: number
  username: string
  name: string
  email?: string
  public_email?: string
  avatar_url?: string | null
  state?: string
}

export interface GitLabProject {
  id: number
  name: string
  path_with_namespace: string
  web_url: string
  default_branch: string | null
  archived: boolean
  last_activity_at: string
}

export interface GitLabMergeRequest {
  id: number
  iid: number
  project_id: number
  title: string
  description: string | null
  state: 'opened' | 'closed' | 'merged' | 'locked'
  draft?: boolean
  work_in_progress?: boolean
  source_branch: string
  target_branch: string
  web_url: string
  author: GitLabUser | null
  merged_by?: GitLabUser | null
  merge_user?: GitLabUser | null
  created_at: string
  updated_at: string
  merged_at: string | null
  closed_at: string | null
  labels: string[]
  user_notes_count?: number
  /** Only present when the MR is fetched individually (not in list responses). */
  changes_count?: string
  diff_stats?: { additions: number; deletions: number; file_count: number }
}

export interface GitLabMergeRequestNote {
  id: number
  body: string
  author: GitLabUser | null
  created_at: string
  system: boolean
  resolvable: boolean
  resolved?: boolean
}

export interface GitLabCommit {
  id: string
  short_id: string
  title: string
  author_name: string
  author_email: string
  authored_date: string
  committed_date: string
  parent_ids: string[]
  /**
   * Only present when something asked for it — `with_stats` on a listing, or the
   * single-commit endpoint. `total` is not always echoed back, so it is optional:
   * callers add the two halves rather than trusting a field GitLab may omit.
   */
  stats?: { additions: number; deletions: number; total?: number }
}

export interface GitLabApproval {
  user: GitLabUser
}

export interface GitLabDeployment {
  id: number
  iid: number
  ref: string
  sha: string
  status: 'created' | 'running' | 'success' | 'failed' | 'canceled' | 'blocked'
  created_at: string
  updated_at: string
  environment: { name: string } | null
  user?: GitLabUser | null
  deployable?: {
    finished_at?: string | null
    user?: GitLabUser | null
  } | null
}

export interface GitLabPipeline {
  id: number
  ref: string
  sha: string
  status: string
  source: string
  created_at: string
  updated_at: string
  started_at?: string | null
  finished_at?: string | null
  duration?: number | null
}

/**
 * Page budget for a merge-request listing, and the record count it implies.
 * Exported because the sync has to know whether a result was truncated: a full
 * page-limit result means there is more beyond it, and the cursor must be left
 * where the next run can pick it up.
 */
export const MR_PAGE_MAX_PAGES = 30
export const MR_PAGE_LIMIT = MR_PAGE_MAX_PAGES * 100

/**
 * Same idea for deployments and pipelines, but a much larger budget. These cost one
 * call per hundred records with no per-record follow-up, and a busy project produces
 * them in enormous numbers — this org emits roughly 2,000 deployments every seven
 * hours across 172 environments, so a 20-page cap meant a three-month window would
 * have taken hundreds of runs to walk.
 */
export const EVENT_PAGE_MAX_PAGES = 200
export const EVENT_PAGE_LIMIT = EVENT_PAGE_MAX_PAGES * 100

export class GitLabClient {
  private readonly host: string
  private readonly token: string

  constructor() {
    const env = gitlabEnv()
    if (!env.token) {
      throw new IntegrationError('GITLAB_TOKEN is not configured', 0, 'gitlab')
    }
    this.host = env.host.replace(/\/+$/, '')
    this.token = env.token
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const url = new URL(`${this.host}/api/v4${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  private async get<T>(path: string, params?: Record<string, string | number | undefined>) {
    return requestJson<T>(this.url(path, params), {
      source: 'gitlab',
      headers: { 'PRIVATE-TOKEN': this.token },
    })
  }

  /**
   * Per-file change metadata for a merge request, without the diff bodies.
   *
   * This is the only source here that answers "which files, and how much of each"
   * without downloading the code. REST has no such endpoint — `/diffs` and
   * `/changes` both bundle the diff text, so a large merge request costs megabytes
   * — whereas GraphQL's `diffStats` is a list of `{path, additions, deletions}` and
   * nothing else, in one request.
   *
   * Worth it for more than bandwidth: the paths are what let a lockfile bump stop
   * counting as five thousand lines of work (see `file-classes.ts`). Line counts
   * alone cannot tell that apart from a refactor.
   *
   * Returns null rather than throwing when GraphQL is unavailable or the merge
   * request cannot be read, so a caller falls back to commit sums instead of losing
   * the slice. `errors` in a 200 response is GraphQL's normal failure channel and is
   * treated as absence, not as success.
   */
  async mergeRequestDiffStats(
    projectPath: string,
    iid: number,
  ): Promise<{
    files: { path: string; additions: number; deletions: number }[]
    summary: { additions: number; deletions: number; fileCount: number } | null
  } | null> {
    const query = `
      query mrDiffStats($project: ID!, $iid: String!) {
        project(fullPath: $project) {
          mergeRequest(iid: $iid) {
            diffStatsSummary { additions deletions fileCount }
            diffStats { path additions deletions }
          }
        }
      }`

    try {
      const { data } = await requestJson<{
        data?: {
          project?: {
            mergeRequest?: {
              diffStatsSummary?: { additions: number; deletions: number; fileCount: number } | null
              diffStats?: { path: string; additions: number; deletions: number }[] | null
            } | null
          } | null
        }
        errors?: { message: string }[]
      }>(`${this.host}/api/graphql`, {
        source: 'gitlab',
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: { project: projectPath, iid: String(iid) } }),
      })

      if (data.errors?.length) return null
      const mr = data.data?.project?.mergeRequest
      if (!mr) return null
      const files = mr.diffStats ?? []
      // An empty file list with no summary means GraphQL answered but knows nothing
      // about this merge request's diff — absence, not a change of size zero.
      if (files.length === 0 && !mr.diffStatsSummary) return null
      return { files, summary: mr.diffStatsSummary ?? null }
    } catch (error) {
      if (error instanceof IntegrationError && [400, 403, 404, 405].includes(error.status)) {
        return null
      }
      throw error
    }
  }

  /**
   * Keyset-free offset pagination. GitLab caps per_page at 100; we stop as soon
   * as a short page comes back or the caller's limit is reached.
   */
  private async getAll<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    maxPages = 50,
  ): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.get<T[]>(path, { ...params, per_page: 100, page })
      if (!Array.isArray(data) || data.length === 0) break
      out.push(...data)
      if (data.length < 100) break
    }
    return out
  }

  async currentUser(): Promise<GitLabUser> {
    const { data } = await this.get<GitLabUser>('/user')
    return data
  }

  /** Projects under a group, including subgroups. */
  async groupProjects(groupPath: string): Promise<GitLabProject[]> {
    return this.getAll<GitLabProject>(`/groups/${encodeURIComponent(groupPath)}/projects`, {
      include_subgroups: 'true',
      archived: 'false',
      with_shared: 'false',
      order_by: 'last_activity_at',
    })
  }

  async project(idOrPath: string | number): Promise<GitLabProject> {
    const { data } = await this.get<GitLabProject>(`/projects/${encodeURIComponent(String(idOrPath))}`)
    return data
  }

  /**
   * Merge requests in an updated_at window. Windowing on updated_at rather than
   * created_at is what makes an incremental sync catch a merge request that was
   * opened long ago but merged today.
   *
   * The result is truncated at MR_PAGE_LIMIT, so sort order decides which end of
   * the window survives — and the caller's cursor has to agree with it. Walking
   * forward from the oldest wants 'asc'; walking backward from the newest wants
   * 'desc' plus an updatedBefore frontier. Either way the truncation must fall on
   * the side the next run will resume from, or the dropped merge requests are
   * never fetched again.
   */
  async mergeRequests(
    projectId: number,
    updatedAfter: string,
    options: { updatedBefore?: string; sort?: 'asc' | 'desc'; maxPages?: number } = {},
  ): Promise<GitLabMergeRequest[]> {
    return this.getAll<GitLabMergeRequest>(
      `/projects/${projectId}/merge_requests`,
      {
        updated_after: updatedAfter,
        updated_before: options.updatedBefore,
        scope: 'all',
        state: 'all',
        order_by: 'updated_at',
        sort: options.sort ?? 'asc',
        view: 'simple',
      },
      options.maxPages ?? MR_PAGE_MAX_PAGES,
    )
  }

  /** Full MR payload, needed for diff_stats which the list view omits. */
  async mergeRequest(projectId: number, iid: number): Promise<GitLabMergeRequest> {
    const { data } = await this.get<GitLabMergeRequest>(
      `/projects/${projectId}/merge_requests/${iid}`,
    )
    return data
  }

  async mergeRequestNotes(projectId: number, iid: number): Promise<GitLabMergeRequestNote[]> {
    return this.getAll<GitLabMergeRequestNote>(
      `/projects/${projectId}/merge_requests/${iid}/notes`,
      { order_by: 'created_at', sort: 'asc' },
      5,
    )
  }

  /**
   * Commits on a merge request.
   *
   * `with_stats` is requested because it costs nothing to ask: where the instance
   * honours it, every commit arrives with its line counts and no follow-up call is
   * needed. GitLab ignores query parameters it does not recognise, so this is safe
   * on versions that do not support it — and `commitStats` below is the fallback
   * for exactly that case. The stats are not assumed present anywhere; callers
   * check, because assuming they were there is what produced 9,893 commits with a
   * size of zero.
   */
  async mergeRequestCommits(projectId: number, iid: number): Promise<GitLabCommit[]> {
    return this.getAll<GitLabCommit>(
      `/projects/${projectId}/merge_requests/${iid}/commits`,
      { with_stats: 'true' },
      5,
    )
  }

  /**
   * One commit, with its line counts. The single-commit endpoint documents `stats`,
   * which is why this is the fallback of record rather than something cleverer: it
   * costs a call per commit, but it is the only source here that is certain.
   *
   * A missing or inaccessible commit returns null rather than throwing — a force-push
   * can leave a merge request referencing a sha that no longer resolves, and one dead
   * sha must not end a sync slice.
   */
  async commitStats(
    projectId: number,
    sha: string,
  ): Promise<{ additions: number; deletions: number } | null> {
    try {
      const { data } = await this.get<GitLabCommit>(
        `/projects/${projectId}/repository/commits/${encodeURIComponent(sha)}`,
      )
      if (!data.stats) return null
      return { additions: data.stats.additions ?? 0, deletions: data.stats.deletions ?? 0 }
    } catch (error) {
      if (error instanceof IntegrationError && [403, 404].includes(error.status)) return null
      throw error
    }
  }

  /**
   * Approvals. Not available on every GitLab tier, so a 403/404 is treated as
   * "no approval data" rather than a sync failure.
   */
  async mergeRequestApprovals(
    projectId: number,
    iid: number,
  ): Promise<{ approved_by: GitLabApproval[] } | null> {
    try {
      const { data } = await this.get<{ approved_by: GitLabApproval[] }>(
        `/projects/${projectId}/merge_requests/${iid}/approvals`,
      )
      return data
    } catch (error) {
      if (error instanceof IntegrationError && [403, 404].includes(error.status)) return null
      throw error
    }
  }

  async commits(projectId: number, since: string, ref?: string): Promise<GitLabCommit[]> {
    return this.getAll<GitLabCommit>(
      `/projects/${projectId}/repository/commits`,
      { since, ref_name: ref, with_stats: 'true' },
      30,
    )
  }

  /**
   * Deployments in an updated_at window. Truncated at EVENT_PAGE_LIMIT, so the
   * same rule as merge requests applies: the sort has to drop the end the caller's
   * cursor will resume from. A busy project deploys far more often than it merges
   * — this org has 172 environments — so this cap is reached easily.
   */
  async deployments(
    projectId: number,
    updatedAfter: string,
    options: { updatedBefore?: string; sort?: 'asc' | 'desc' } = {},
  ): Promise<GitLabDeployment[]> {
    return this.getAll<GitLabDeployment>(
      `/projects/${projectId}/deployments`,
      {
        updated_after: updatedAfter,
        updated_before: options.updatedBefore,
        order_by: 'updated_at',
        sort: options.sort ?? 'asc',
      },
      EVENT_PAGE_MAX_PAGES,
    )
  }

  async pipelines(
    projectId: number,
    updatedAfter: string,
    options: { updatedBefore?: string; sort?: 'asc' | 'desc' } = {},
  ): Promise<GitLabPipeline[]> {
    return this.getAll<GitLabPipeline>(
      `/projects/${projectId}/pipelines`,
      {
        updated_after: updatedAfter,
        updated_before: options.updatedBefore,
        order_by: 'updated_at',
        sort: options.sort ?? 'asc',
      },
      EVENT_PAGE_MAX_PAGES,
    )
  }
}

/** Draft flag moved between fields across GitLab versions. */
export function isDraft(mr: GitLabMergeRequest): boolean {
  return Boolean(mr.draft ?? mr.work_in_progress ?? false)
}

/**
 * Pull Jira issue keys out of an MR's title, branch and description so code can
 * be tied back to tickets. Deliberately conservative: uppercase project key,
 * hyphen, digits.
 */
export function extractJiraKeys(mr: GitLabMergeRequest, knownProjectKeys: string[]): string[] {
  const haystack = [mr.title, mr.source_branch, mr.description ?? ''].join(' ')
  const matches = haystack.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? []
  const allowed = new Set(knownProjectKeys.map((k) => k.toUpperCase()))
  const keys = matches.filter((m) => allowed.size === 0 || allowed.has(m.split('-')[0]))
  return Array.from(new Set(keys))
}
