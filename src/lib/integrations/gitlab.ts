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
  stats?: { additions: number; deletions: number; total: number }
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
   * Merge requests updated since a timestamp. Using updated_after (rather than
   * created_after) is what makes the incremental sync catch MRs that were
   * opened long ago but merged today.
   */
  async mergeRequests(
    projectId: number,
    updatedAfter: string,
    maxPages = 30,
  ): Promise<GitLabMergeRequest[]> {
    return this.getAll<GitLabMergeRequest>(
      `/projects/${projectId}/merge_requests`,
      {
        updated_after: updatedAfter,
        scope: 'all',
        state: 'all',
        order_by: 'updated_at',
        sort: 'desc',
        view: 'simple',
      },
      maxPages,
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

  async mergeRequestCommits(projectId: number, iid: number): Promise<GitLabCommit[]> {
    return this.getAll<GitLabCommit>(
      `/projects/${projectId}/merge_requests/${iid}/commits`,
      {},
      5,
    )
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

  async deployments(projectId: number, updatedAfter: string): Promise<GitLabDeployment[]> {
    return this.getAll<GitLabDeployment>(
      `/projects/${projectId}/deployments`,
      { updated_after: updatedAfter, order_by: 'updated_at', sort: 'desc' },
      20,
    )
  }

  async pipelines(projectId: number, updatedAfter: string): Promise<GitLabPipeline[]> {
    return this.getAll<GitLabPipeline>(
      `/projects/${projectId}/pipelines`,
      { updated_after: updatedAfter, order_by: 'updated_at', sort: 'desc' },
      20,
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
