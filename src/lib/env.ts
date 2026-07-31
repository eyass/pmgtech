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

/**
 * The cron schedules in `vercel.json`, named here because a JSON file cannot hold a
 * comment and because `cronStatus` has to be able to say what is not running.
 */
export const CRON_SCHEDULES = [
  { path: '/api/sync', schedule: '0 3 * * *', what: 'pulls GitLab, Jira and HiBob' },
  { path: '/api/snapshots', schedule: '0 6 * * *', what: 'records the day’s scores' },
] as const

/**
 * Whether the scheduled runs can authenticate themselves at all.
 *
 * Kept apart from `integrationStatus` because it is a different kind of missing, and
 * a far quieter one. An unconfigured integration is skipped by a run that still
 * happens: it opens a `sync_runs` row, finishes it, and names the variable it wants
 * in its own response. An unset `CRON_SECRET` is refused by `authoriseSync` *before*
 * that row exists, so nothing is recorded anywhere and the only symptom is data that
 * stops arriving — which reads as a quiet week, not as a broken scheduler.
 *
 * Both failure paths are worth stating, because neither is the one you would guess:
 *
 *  - Vercel only attaches `Authorization: Bearer $CRON_SECRET` when the variable is
 *    set. Unset, the scheduled request arrives with no credentials at all, falls
 *    through to the session branch, and is answered **401 Not signed in** — exactly
 *    what a stranger gets, so nothing in the answer hints at a misconfiguration.
 *  - A bearer call made by hand against the same deployment gets **503**, and that is
 *    the only place the real reason is ever stated.
 *
 * Both were true of production on 2026-07-31: `/api/sync` answered 401 to an
 * anonymous request and 503 to a bearer token, while `sync_runs` held nothing newer
 * than 2026-07-28. This is the same silent-failure shape as a cron missing from
 * `PUBLIC_PATHS`, one rejection code along.
 */
export function cronStatus() {
  const secret = optional('CRON_SECRET')
  return {
    configured: Boolean(secret),
    missing: secret ? [] : ['CRON_SECRET'],
    schedules: CRON_SCHEDULES,
  }
}

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
