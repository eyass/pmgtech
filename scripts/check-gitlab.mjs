#!/usr/bin/env node
/**
 * GitLab preflight. Read-only — touches no database and writes nothing.
 *
 *   npm run check:gitlab
 *
 * Answers, in order, the questions that actually block a first sync:
 *   1. Is the token valid, and does it have read_api?
 *   2. Which projects would the sync discover from GITLAB_GROUPS / GITLAB_PROJECTS?
 *   3. How much merge-request history is in the backfill window?
 *   4. Roughly how many API calls will that cost, and how many cron runs?
 *
 * Deliberately separate from the sync so it can run before SUPABASE_SERVICE_ROLE_KEY
 * exists. The sync needs that key to write; this needs nothing but the token.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// --- config -------------------------------------------------------------------

/** Minimal .env parser so this runs with no dependencies. */
function loadEnvFile(path) {
  try {
    const text = readFileSync(resolve(process.cwd(), path), 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    // No .env.local is fine — the values may come from the real environment.
  }
}

loadEnvFile('.env.local')
loadEnvFile('.env')

/**
 * Hours between sync runs, read from vercel.json rather than assumed — the
 * schedule is plan-dependent (Hobby allows one run a day), and an estimate based
 * on the wrong interval is worse than no estimate.
 */
function cronInterval() {
  try {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'))
    const schedule = config?.crons?.[0]?.schedule
    if (typeof schedule === 'string') {
      const hourField = schedule.trim().split(/\s+/)[1]
      if (hourField === '*') return { hours: 1, label: 'hourly' }
      const step = /^\*\/(\d+)$/.exec(hourField)
      if (step) return { hours: Number(step[1]), label: `every ${step[1]}h` }
      // A fixed hour, or a list of them: one run per listed hour per day.
      const runsPerDay = hourField.split(',').filter(Boolean).length || 1
      return {
        hours: 24 / runsPerDay,
        label: runsPerDay === 1 ? 'once a day' : `${runsPerDay}x a day`,
      }
    }
  } catch {
    // No vercel.json, or unparseable — fall through to the documented default.
  }
  return { hours: 24, label: 'once a day (assumed)' }
}

const HOST = (process.env.GITLAB_HOST ?? 'https://gitlab.com').replace(/\/+$/, '')
const TOKEN = process.env.GITLAB_TOKEN
const GROUPS = (process.env.GITLAB_GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const PROJECTS = (process.env.GITLAB_PROJECTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const BACKFILL_MONTHS = Number(process.env.BACKFILL_MONTHS ?? '12')

const c = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m',
}
const ok = (s) => `${c.green}✓${c.reset} ${s}`
const bad = (s) => `${c.red}✗${c.reset} ${s}`
const warn = (s) => `${c.yellow}!${c.reset} ${s}`
const head = (s) => `\n${c.bold}${s}${c.reset}`

// --- http ---------------------------------------------------------------------

async function api(path, params = {}) {
  const url = new URL(`${HOST}/api/v4${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const response = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': TOKEN, Accept: 'application/json' },
  })
  const text = await response.text()
  let body = null
  try {
    body = text.length ? JSON.parse(text) : null
  } catch {
    body = text.slice(0, 300)
  }
  return { status: response.status, headers: response.headers, body }
}

/** Total row count from the X-Total header, which GitLab sets on offset pagination. */
async function countOf(path, params = {}) {
  const res = await api(path, { ...params, per_page: 1, page: 1 })
  if (res.status !== 200) return { error: res.status, total: null }
  const total = res.headers.get('x-total')
  return { error: null, total: total === null ? null : Number(total) }
}

// --- checks -------------------------------------------------------------------

async function main() {
  console.log(`${c.bold}GitLab preflight${c.reset} ${c.dim}(read-only)${c.reset}`)
  console.log(`${c.dim}host   ${HOST}${c.reset}`)

  if (!TOKEN) {
    console.log(bad('GITLAB_TOKEN is not set.'))
    console.log(`
Add it to ${c.cyan}.env.local${c.reset} without putting the value in a chat message
or your shell history:

  ${c.dim}# paste the token when prompted, then press enter${c.reset}
  read -rs TOKEN && echo "GITLAB_TOKEN=$TOKEN" >> .env.local && unset TOKEN

Then set the scope of the sync:

  echo 'GITLAB_HOST=https://gitlab.com'   >> .env.local
  echo 'GITLAB_GROUPS=your-group'         >> .env.local

The token needs the ${c.bold}read_api${c.reset} scope. A group access token is preferable to a
personal one, so the integration does not break when someone leaves.
`)
    process.exit(1)
  }

  // 1. token validity and scopes
  console.log(head('1. Token'))
  const me = await api('/user')
  if (me.status === 401) {
    console.log(bad('401 Unauthorized — the token is invalid, revoked or expired.'))
    process.exit(1)
  }
  if (me.status !== 200) {
    console.log(bad(`GET /user returned ${me.status}: ${JSON.stringify(me.body).slice(0, 200)}`))
    process.exit(1)
  }
  console.log(ok(`Authenticated as ${c.bold}${me.body.username}${c.reset} (${me.body.name ?? 'no name'})`))

  const self = await api('/personal_access_tokens/self')
  if (self.status === 200 && Array.isArray(self.body?.scopes)) {
    const scopes = self.body.scopes
    const hasRead = scopes.includes('read_api') || scopes.includes('api')
    console.log(
      hasRead
        ? ok(`Scopes: ${scopes.join(', ')}`)
        : bad(`Scopes: ${scopes.join(', ')} — needs read_api (or api)`),
    )
    if (self.body.expires_at) {
      const days = Math.round((new Date(self.body.expires_at) - Date.now()) / 86_400_000)
      console.log(days < 30 ? warn(`Token expires in ${days} days`) : ok(`Expires ${self.body.expires_at}`))
    }
    if (!hasRead) process.exit(1)
  } else {
    // Group and project access tokens cannot read this endpoint; not a failure.
    console.log(`${c.dim}  Scope list unavailable (normal for group/project tokens).${c.reset}`)
  }

  // 2. discovery
  console.log(head('2. Project discovery'))
  if (GROUPS.length === 0 && PROJECTS.length === 0) {
    console.log(bad('Neither GITLAB_GROUPS nor GITLAB_PROJECTS is set — the sync would find nothing.'))
    console.log(`${c.dim}  Set GITLAB_GROUPS to a top-level group path; subgroups are included automatically.${c.reset}`)
    process.exit(1)
  }

  const discovered = new Map()

  for (const group of GROUPS) {
    const res = await api(`/groups/${encodeURIComponent(group)}/projects`, {
      include_subgroups: 'true', archived: 'false', with_shared: 'false',
      order_by: 'last_activity_at', per_page: 100,
    })
    if (res.status === 404) {
      console.log(bad(`Group ${c.bold}${group}${c.reset} not found, or the token cannot see it.`))
      continue
    }
    if (res.status === 403) {
      console.log(bad(`Group ${c.bold}${group}${c.reset} — 403 Forbidden. Token lacks access.`))
      continue
    }
    if (res.status !== 200) {
      console.log(bad(`Group ${group} returned ${res.status}`))
      continue
    }
    for (const p of res.body) discovered.set(p.id, p)
    const total = res.headers.get('x-total')
    console.log(ok(`Group ${c.bold}${group}${c.reset}: ${res.body.length} projects fetched${total && Number(total) > res.body.length ? ` of ${total} (first page only)` : ''}`))
  }

  for (const ref of PROJECTS) {
    const res = await api(`/projects/${encodeURIComponent(ref)}`)
    if (res.status !== 200) {
      console.log(bad(`Project ${ref} returned ${res.status}`))
      continue
    }
    discovered.set(res.body.id, res.body)
    console.log(ok(`Project ${c.bold}${res.body.path_with_namespace}${c.reset}`))
  }

  if (discovered.size === 0) {
    console.log(bad('No projects discovered. Nothing to sync.'))
    process.exit(1)
  }

  const projects = [...discovered.values()].sort(
    (a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at),
  )
  console.log(ok(`${c.bold}${projects.length}${c.reset} distinct projects total`))

  // 3. how much history is there
  const since = new Date()
  since.setMonth(since.getMonth() - BACKFILL_MONTHS)
  const sinceIso = since.toISOString()

  console.log(head(`3. Merge-request volume since ${sinceIso.slice(0, 10)} (${BACKFILL_MONTHS} months)`))
  const sample = projects.slice(0, 15)
  let sampledMrs = 0
  let deployTotal = 0
  let anyDeployments = false

  for (const p of sample) {
    const mrs = await countOf(`/projects/${p.id}/merge_requests`, {
      updated_after: sinceIso, scope: 'all', state: 'all',
    })
    const deps = await countOf(`/projects/${p.id}/deployments`, { updated_after: sinceIso })
    if (deps.total) { deployTotal += deps.total; anyDeployments = true }

    const label = p.path_with_namespace.padEnd(46).slice(0, 46)
    if (mrs.error) {
      console.log(`  ${bad(label)} ${mrs.error}`)
      continue
    }
    sampledMrs += mrs.total ?? 0
    const flag = (mrs.total ?? 0) === 0 ? c.dim : ''
    console.log(`  ${flag}${label} ${String(mrs.total ?? '?').padStart(6)} MRs   ${String(deps.total ?? 0).padStart(5)} deploys${c.reset}`)
  }

  if (projects.length > sample.length) {
    console.log(`${c.dim}  … ${projects.length - sample.length} more projects not sampled${c.reset}`)
  }

  // 4. cost estimate
  console.log(head('4. Estimated first-sync cost'))
  const perProject = sampledMrs / Math.max(sample.length, 1)
  const estimatedMrs = Math.round(perProject * projects.length)
  // detail + commits + notes + approvals per MR, plus paging overhead
  const estimatedCalls = estimatedMrs * 4 + projects.length * 6
  const callsPerRun = 2500 // conservative for a ~4 min serverless window at 4x concurrency
  const runs = Math.max(1, Math.ceil(estimatedCalls / callsPerRun))

  const { hours: cronHours, label: cronLabel } = cronInterval()
  const unattendedDays = (runs * cronHours) / 24

  console.log(`  Merge requests in window   ~${estimatedMrs.toLocaleString('en-GB')}`)
  console.log(`  API calls for full backfill ~${estimatedCalls.toLocaleString('en-GB')}  ${c.dim}(4 per MR + discovery)${c.reset}`)
  console.log(
    `  Cron runs to catch up      ~${runs}  ${c.dim}(${cronLabel} → about ${unattendedDays.toFixed(1)} days unattended)${c.reset}`,
  )
  // A backfill this size is not something to leave to the cron. Say so, rather
  // than printing a two-week estimate as though it were a plan.
  if (unattendedDays > 1) {
    console.log(
      warn(
        `That is a long time to leave a backfill running. Drive the first pass by hand instead: POST /api/sync?source=gitlab&mode=backfill ONCE to open the window, then repeat with mode=incremental until ran_out_of_time is 0. Only incremental reads the stored cursor — looping on mode=backfill restarts from the oldest merge request every time and never finishes. Lowering BACKFILL_MONTHS also works.`,
      ),
    )
  }
  if (!anyDeployments) {
    console.log(warn('No deployments found in the sampled projects — deploy frequency, change failure rate and MTTR will all be empty.'))
    console.log(`${c.dim}  Those metrics come from GitLab Deployments (environments), not from pipelines or tags.${c.reset}`)
  } else {
    console.log(ok(`${deployTotal.toLocaleString('en-GB')} deployments in sampled projects — DORA metrics will populate`))
  }
  if (runs > 20) {
    console.log(warn(`That is a long backfill. Consider lowering BACKFILL_MONTHS, or untracking noisy repos in the admin page after the first run.`))
  }

  console.log(head('Next'))
  console.log(`  ${projects.length} projects, ~${estimatedMrs.toLocaleString('en-GB')} merge requests are reachable with this token.`)
  console.log(`  To actually write them to Supabase you also need ${c.cyan}SUPABASE_SERVICE_ROLE_KEY${c.reset} (issue #3),`)
  console.log(`  then: ${c.cyan}curl -X POST localhost:3000/api/sync?source=gitlab${c.reset} or use the admin page.\n`)
}

main().catch((error) => {
  console.error(bad(`Preflight failed: ${error.message}`))
  process.exit(1)
})
