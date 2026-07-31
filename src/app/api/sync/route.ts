import { NextResponse, type NextRequest } from 'next/server'

import { integrationStatus } from '@/lib/env'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { authoriseSync, recordRejectedCron } from '@/lib/sync/auth'
import { syncGitLab } from '@/lib/sync/gitlab'
import { syncHiBob } from '@/lib/sync/hibob'
import { syncJira } from '@/lib/sync/jira'
import { expireAbandonedRuns, type SyncMode } from '@/lib/sync/runner'

/**
 * Sync orchestrator. Also the Vercel Cron target.
 *
 * Order matters: HiBob first so the engineer directory exists, then Jira and
 * GitLab, which resolve their authors against it.
 *
 * Query parameters:
 *   ?source=all|gitlab|jira|hibob   which sources to run (default all)
 *   ?mode=incremental|backfill      ignore stored cursors and pull the window
 *   ?projects=<n>                   cap GitLab projects, useful for a first test
 */
export const maxDuration = 300
export const dynamic = 'force-dynamic'

type Source = 'all' | 'gitlab' | 'jira' | 'hibob'

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  const caller = await authoriseSync(request)
  if (caller.kind === 'denied') {
    // A refused scheduled run is written down before the answer goes out. Otherwise
    // the only trace is a non-2xx in Vercel's cron log, `sync_runs` keeps whatever row
    // it had before the scheduler broke, and the app reports "gitlab last completed 72
    // hours ago" — a true sentence that points at the wrong thing.
    await recordRejectedCron(request, caller)
    return NextResponse.json({ error: caller.reason }, { status: caller.status })
  }

  // Close anything a previous invocation abandoned, before opening rows of our own. A
  // run killed past its budget cannot write its own ending, and left open it reads as
  // a run still in flight — which is how four dead rows made a stopped sync look busy.
  const reaped = await expireAbandonedRuns(supabaseAdmin())

  const params = request.nextUrl.searchParams
  const source = (params.get('source') ?? 'all') as Source
  const mode: SyncMode = params.get('mode') === 'backfill' ? 'backfill' : 'incremental'
  const projectLimit = params.get('projects') ? Number(params.get('projects')) : undefined
  const trigger = caller.kind === 'cron' ? 'cron' : 'manual'

  if (!['all', 'gitlab', 'jira', 'hibob'].includes(source)) {
    return NextResponse.json({ error: `Unknown source "${source}"` }, { status: 400 })
  }

  const status = integrationStatus()
  const results: Record<string, unknown> = {}
  const skipped: Record<string, string[]> = {}
  const failures: Record<string, string> = {}

  // The whole request shares one budget. Splitting it between sources keeps a
  // slow GitLab backfill from starving the Jira sync entirely.
  const totalBudgetMs = 270_000
  const sourcesToRun = source === 'all' ? (['hibob', 'jira', 'gitlab'] as const) : ([source] as const)
  const eligible = sourcesToRun.filter((s) => status[s].configured)
  const perSourceBudget = eligible.length > 0 ? Math.floor(totalBudgetMs / eligible.length) : 0

  for (const name of sourcesToRun) {
    if (!status[name].configured) {
      skipped[name] = status[name].missing
      continue
    }

    try {
      if (name === 'hibob') {
        results.hibob = await syncHiBob(mode, trigger)
      } else if (name === 'jira') {
        results.jira = await syncJira(mode, trigger, { budgetMs: perSourceBudget })
      } else {
        results.gitlab = await syncGitLab(mode, trigger, { projectLimit, budgetMs: perSourceBudget })
      }
    } catch (error) {
      // One broken integration should not stop the others; the sync_runs row
      // records the detail and the response says which source failed.
      failures[name] = error instanceof Error ? error.message : String(error)
    }
  }

  const anyRan = Object.keys(results).length > 0
  const httpStatus = anyRan ? 200 : Object.keys(failures).length > 0 ? 500 : 400

  return NextResponse.json(
    {
      mode,
      trigger,
      ran: Object.keys(results),
      results,
      abandonedClosed: reaped.expired > 0 ? reaped : undefined,
      skipped: Object.keys(skipped).length > 0 ? skipped : undefined,
      failures: Object.keys(failures).length > 0 ? failures : undefined,
      hint:
        Object.keys(skipped).length > 0
          ? 'Set the listed environment variables in Vercel, then redeploy and run the sync again.'
          : undefined,
    },
    { status: httpStatus },
  )
}
