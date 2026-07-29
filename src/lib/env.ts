/**
 * Environment access.
 *
 * Integration credentials are read lazily rather than validated at module load,
 * because the dashboard must still render (and tell you what is missing) when a
 * source has not been configured yet. Only the Supabase values are required for
 * the app to boot at all.
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for the full list.`,
    )
  }
  return value
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export const supabaseEnv = {
  get url() {
    return required('NEXT_PUBLIC_SUPABASE_URL')
  },
  get anonKey() {
    return required('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  },
  get serviceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY')
  },
}

export type IntegrationName = 'gitlab' | 'jira' | 'hibob'

export const gitlabEnv = () => ({
  host: optional('GITLAB_HOST') ?? 'https://gitlab.com',
  token: optional('GITLAB_TOKEN'),
  /** Comma-separated group paths to discover projects under, e.g. "pmg,pmg/platform". */
  groups: (optional('GITLAB_GROUPS') ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
  /** Optional explicit project ids/paths, used when you do not want a whole group. */
  projects: (optional('GITLAB_PROJECTS') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
})

export const jiraEnv = () => ({
  host: optional('JIRA_HOST'),
  email: optional('JIRA_EMAIL'),
  token: optional('JIRA_API_TOKEN'),
  /** Comma-separated Jira project keys, e.g. "BUY,SELL,MON,GRW". */
  projectKeys: (optional('JIRA_PROJECT_KEYS') ?? '')
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean),
  /** Custom field id holding story points, e.g. "customfield_10016". */
  storyPointsField: optional('JIRA_STORY_POINTS_FIELD') ?? 'customfield_10016',
  /** Custom field id holding the sprint array, e.g. "customfield_10020". */
  sprintField: optional('JIRA_SPRINT_FIELD') ?? 'customfield_10020',
})

export const hibobEnv = () => ({
  baseUrl: optional('HIBOB_BASE_URL') ?? 'https://api.hibob.com',
  serviceUserId: optional('HIBOB_SERVICE_USER_ID'),
  serviceUserToken: optional('HIBOB_SERVICE_USER_TOKEN'),
  /**
   * HiBob department values that count as engineering. Anyone outside these is
   * skipped so the directory does not fill up with the whole company.
   */
  engineeringDepartments: (optional('HIBOB_ENGINEERING_DEPARTMENTS') ?? 'Engineering,Technology,Tech')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),
})

export const appEnv = () => ({
  cronSecret: optional('CRON_SECRET'),
  allowedEmailDomain: optional('ALLOWED_EMAIL_DOMAIN') ?? 'petmediagroup.com',
  /** Set to 'true' to run without auth — local development only. */
  disableAuth: optional('DISABLE_AUTH') === 'true',
  backfillMonths: Number(optional('BACKFILL_MONTHS') ?? '12'),
  siteUrl:
    optional('NEXT_PUBLIC_SITE_URL') ??
    (optional('VERCEL_PROJECT_PRODUCTION_URL')
      ? `https://${optional('VERCEL_PROJECT_PRODUCTION_URL')}`
      : optional('VERCEL_URL')
        ? `https://${optional('VERCEL_URL')}`
        : 'http://localhost:3000'),
})

/** Which integrations have enough configuration to attempt a sync. */
export function integrationStatus() {
  const gl = gitlabEnv()
  const jr = jiraEnv()
  const hb = hibobEnv()
  return {
    gitlab: {
      configured: Boolean(gl.token) && (gl.groups.length > 0 || gl.projects.length > 0),
      missing: [
        !gl.token && 'GITLAB_TOKEN',
        gl.groups.length === 0 && gl.projects.length === 0 && 'GITLAB_GROUPS or GITLAB_PROJECTS',
      ].filter(Boolean) as string[],
    },
    jira: {
      configured: Boolean(jr.host && jr.email && jr.token && jr.projectKeys.length > 0),
      missing: [
        !jr.host && 'JIRA_HOST',
        !jr.email && 'JIRA_EMAIL',
        !jr.token && 'JIRA_API_TOKEN',
        jr.projectKeys.length === 0 && 'JIRA_PROJECT_KEYS',
      ].filter(Boolean) as string[],
    },
    hibob: {
      configured: Boolean(hb.serviceUserId && hb.serviceUserToken),
      missing: [
        !hb.serviceUserId && 'HIBOB_SERVICE_USER_ID',
        !hb.serviceUserToken && 'HIBOB_SERVICE_USER_TOKEN',
      ].filter(Boolean) as string[],
    },
  }
}
