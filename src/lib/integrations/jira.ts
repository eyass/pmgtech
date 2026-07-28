import { jiraEnv } from '@/lib/env'
import { IntegrationError, requestJson } from '@/lib/integrations/http'

/**
 * Jira Cloud client. Uses the v3 platform API for issues plus the Agile API for
 * boards and sprints, authenticated with an email + API token pair.
 */

export interface JiraUser {
  accountId: string
  displayName: string
  emailAddress?: string
  avatarUrls?: Record<string, string>
  active?: boolean
}

export interface JiraProject {
  id: string
  key: string
  name: string
  projectTypeKey?: string
}

export interface JiraBoard {
  id: number
  name: string
  type: string
  location?: { projectKey?: string; projectName?: string }
}

export interface JiraSprint {
  id: number
  name: string
  state: 'future' | 'active' | 'closed'
  goal?: string
  startDate?: string
  endDate?: string
  completeDate?: string
  originBoardId?: number
}

export interface JiraIssueFields {
  summary: string
  created: string
  updated: string
  resolutiondate: string | null
  duedate: string | null
  labels: string[]
  issuetype?: { name: string; subtask?: boolean }
  status?: { name: string; statusCategory?: { name: string } }
  resolution?: { name: string } | null
  priority?: { name: string } | null
  assignee?: JiraUser | null
  reporter?: JiraUser | null
  parent?: { key: string } | null
  components?: { name: string }[]
  project?: { key: string }
  [custom: string]: unknown
}

export interface JiraChangelogItem {
  field: string
  fieldId?: string
  fromString: string | null
  toString: string | null
  from: string | null
  to: string | null
}

export interface JiraChangelogEntry {
  id: string
  created: string
  author?: JiraUser | null
  items: JiraChangelogItem[]
}

export interface JiraIssue {
  id: string
  key: string
  fields: JiraIssueFields
  changelog?: { histories: JiraChangelogEntry[] }
}

export class JiraClient {
  private readonly host: string
  private readonly auth: string
  readonly storyPointsField: string
  readonly sprintField: string

  constructor() {
    const env = jiraEnv()
    if (!env.host || !env.email || !env.token) {
      throw new IntegrationError(
        'JIRA_HOST, JIRA_EMAIL and JIRA_API_TOKEN must all be configured',
        0,
        'jira',
      )
    }
    this.host = env.host.replace(/\/+$/, '')
    this.auth = Buffer.from(`${env.email}:${env.token}`).toString('base64')
    this.storyPointsField = env.storyPointsField
    this.sprintField = env.sprintField
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    init: { method?: string; body?: unknown } = {},
  ) {
    const url = new URL(`${this.host}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
    return requestJson<T>(url.toString(), {
      source: 'jira',
      method: init.method,
      body: init.body,
      headers: { Authorization: `Basic ${this.auth}` },
    })
  }

  async currentUser(): Promise<JiraUser> {
    const { data } = await this.request<JiraUser>('/rest/api/3/myself')
    return data
  }

  /**
   * Every status in the instance with its category. The changelog only records
   * status *names*, so this map is what lets a transition be classified as
   * entering "In Progress" or "Done" regardless of per-project workflow naming.
   */
  async statusCategories(): Promise<Map<string, string>> {
    const { data } = await this.request<
      { name: string; statusCategory?: { name?: string } }[]
    >('/rest/api/3/status')
    const map = new Map<string, string>()
    for (const status of data ?? []) {
      if (status.name && status.statusCategory?.name) {
        map.set(status.name.toLowerCase(), status.statusCategory.name)
      }
    }
    return map
  }

  async projects(keys: string[]): Promise<JiraProject[]> {
    const out: JiraProject[] = []
    for (const key of keys) {
      try {
        const { data } = await this.request<JiraProject>(`/rest/api/3/project/${key}`)
        out.push(data)
      } catch (error) {
        // A key that no longer exists should not abort the whole sync.
        if (error instanceof IntegrationError && [400, 404].includes(error.status)) continue
        throw error
      }
    }
    return out
  }

  async boards(projectKeys: string[]): Promise<JiraBoard[]> {
    const out: JiraBoard[] = []
    for (const projectKey of projectKeys) {
      let startAt = 0
      for (let page = 0; page < 10; page++) {
        const { data } = await this.request<{
          values: JiraBoard[]
          isLast: boolean
          maxResults: number
        }>('/rest/agile/1.0/board', { projectKeyOrId: projectKey, startAt, maxResults: 50 })
        out.push(...(data.values ?? []))
        if (data.isLast || !data.values?.length) break
        startAt += data.maxResults
      }
    }
    // The same board can be returned for several project keys.
    return Array.from(new Map(out.map((b) => [b.id, b])).values())
  }

  async sprints(boardId: number): Promise<JiraSprint[]> {
    const out: JiraSprint[] = []
    let startAt = 0
    for (let page = 0; page < 20; page++) {
      try {
        const { data } = await this.request<{
          values: JiraSprint[]
          isLast: boolean
          maxResults: number
        }>(`/rest/agile/1.0/board/${boardId}/sprint`, { startAt, maxResults: 50 })
        out.push(...(data.values ?? []))
        if (data.isLast || !data.values?.length) break
        startAt += data.maxResults
      } catch (error) {
        // Kanban boards have no sprints and answer 400.
        if (error instanceof IntegrationError && error.status === 400) break
        throw error
      }
    }
    return out
  }

  /**
   * Issue search via the JQL endpoint, paging with nextPageToken. Changelogs are
   * requested inline so status history and sprint moves arrive in the same pass
   * instead of one extra call per issue.
   */
  async searchIssues(jql: string, maxPages = 100): Promise<JiraIssue[]> {
    const fields = [
      'summary',
      'created',
      'updated',
      'resolutiondate',
      'duedate',
      'labels',
      'issuetype',
      'status',
      'resolution',
      'priority',
      'assignee',
      'reporter',
      'parent',
      'components',
      'project',
      this.storyPointsField,
      this.sprintField,
    ]

    const out: JiraIssue[] = []
    let nextPageToken: string | undefined

    for (let page = 0; page < maxPages; page++) {
      const { data } = await this.request<{
        issues: JiraIssue[]
        nextPageToken?: string
        isLast?: boolean
      }>('/rest/api/3/search/jql', {
        jql,
        fields: fields.join(','),
        expand: 'changelog',
        maxResults: 100,
        nextPageToken,
      })

      out.push(...(data.issues ?? []))
      if (!data.nextPageToken || data.isLast || !data.issues?.length) break
      nextPageToken = data.nextPageToken
    }

    return out
  }

  /** Story points, tolerating the field being absent or a string. */
  storyPoints(issue: JiraIssue): number | null {
    const raw = issue.fields[this.storyPointsField]
    if (raw === null || raw === undefined) return null
    const n = typeof raw === 'string' ? Number(raw) : (raw as number)
    return Number.isFinite(n) ? n : null
  }

  /**
   * Sprints currently attached to an issue. The shape of this custom field
   * varies by Jira version: sometimes objects, sometimes serialised strings.
   */
  issueSprints(issue: JiraIssue): { id: number; name: string; state?: string }[] {
    const raw = issue.fields[this.sprintField]
    if (!Array.isArray(raw)) return []

    const parsed: { id: number; name: string; state?: string }[] = []
    for (const entry of raw) {
      if (entry && typeof entry === 'object' && 'id' in entry) {
        const e = entry as { id: number; name?: string; state?: string }
        parsed.push({ id: Number(e.id), name: e.name ?? `Sprint ${e.id}`, state: e.state })
      } else if (typeof entry === 'string') {
        // Legacy format: "com.atlassian...Sprint@1a2b[id=42,name=Sprint 3,...]"
        const id = entry.match(/id=(\d+)/)?.[1]
        const name = entry.match(/name=([^,\]]+)/)?.[1]
        if (id) parsed.push({ id: Number(id), name: name ?? `Sprint ${id}` })
      }
    }
    return parsed
  }
}

/** Escape a value for safe interpolation into a JQL string literal. */
export function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Bugs raised against production. Jira has no standard field for this, so we
 * look at the label/priority conventions most teams already use and leave the
 * result overridable in the database.
 */
export function looksLikeProductionBug(issue: JiraIssue): boolean {
  const type = issue.fields.issuetype?.name?.toLowerCase() ?? ''
  if (!type.includes('bug') && !type.includes('incident') && !type.includes('defect')) return false
  const labels = (issue.fields.labels ?? []).map((l) => l.toLowerCase())
  const priority = issue.fields.priority?.name?.toLowerCase() ?? ''
  return (
    labels.some((l) => /prod|live|incident|sev[-_]?[12]|hotfix/.test(l)) ||
    /highest|blocker|critical|p1/.test(priority)
  )
}
