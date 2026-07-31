import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'

import { appEnv } from '@/lib/env'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { supabaseServer } from '@/lib/supabase/server'
import { isAdminEmail, isAllowedEmail } from '@/lib/auth'

/**
 * Sync endpoints accept two callers: Vercel Cron (bearer CRON_SECRET) and a
 * signed-in admin pressing the button in the UI. Anything else is rejected.
 */
export type SyncCaller =
  | { kind: 'cron' }
  | { kind: 'user'; email: string }
  | { kind: 'denied'; reason: string; status: number }

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export async function authoriseSync(request: NextRequest): Promise<SyncCaller> {
  const { cronSecret } = appEnv()

  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const provided = authHeader.slice(7)
    if (!cronSecret) {
      return {
        kind: 'denied',
        reason: 'CRON_SECRET is not configured, so bearer-token calls are refused',
        status: 503,
      }
    }
    if (safeEqual(provided, cronSecret)) return { kind: 'cron' }
    return { kind: 'denied', reason: 'Invalid bearer token', status: 401 }
  }

  const supabase = await supabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const email = user?.email
  if (!email) return { kind: 'denied', reason: 'Not signed in', status: 401 }
  if (!isAllowedEmail(email)) {
    return { kind: 'denied', reason: 'Email domain is not allowed', status: 403 }
  }
  if (!(await isAdminEmail(email))) {
    return { kind: 'denied', reason: 'Running a sync requires admin access', status: 403 }
  }

  return { kind: 'user', email }
}

/**
 * Whether this request is Vercel's scheduler rather than a person or a stranger.
 *
 * Vercel stamps `x-vercel-cron` on every scheduled invocation and sends a
 * `vercel-cron/1.0` user agent. Neither is a credential and neither is treated as
 * one — `authoriseSync` has already had its say by the time this is asked. It is used
 * for one thing only: deciding whether a rejection is worth writing down.
 */
export function looksLikeVercelCron(request: NextRequest): boolean {
  if (request.headers.get('x-vercel-cron')) return true
  return /vercel-cron/i.test(request.headers.get('user-agent') ?? '')
}

/** Prefix on the `error` column of a recorded rejection, and the key it dedupes on. */
export const REJECTED_CRON_PREFIX = 'Rejected before the run started'

/**
 * How long the same rejection stays deduped. The scheduler fires daily, so an hour is
 * far longer than needed for that — the window exists for the header being forgeable,
 * not for the cron.
 */
const REJECTION_DEDUPE_MS = 60 * 60_000

/**
 * Write down a scheduled run that was refused before it could open a `sync_runs` row.
 *
 * This is the gap that let the sync stop for three days in silence. `authoriseSync`
 * answers 401 or 503 and returns; `SyncContext.start()` — the only thing that has ever
 * written to `sync_runs` — is never reached. So the database's most recent row stays
 * whatever it was before the scheduler broke, the trust page reports staleness in hours,
 * and nothing anywhere names the cause. Vercel's own cron log records the non-2xx, but
 * that is a different screen with a different retention, and nobody looks at it until
 * they already suspect the cron.
 *
 * Recorded as `source: 'all'` because that is what the schedule asks for and because
 * `readSourceHealth` folds an `all` run into every source — a rejected cron does break
 * all three, and each one should say so.
 *
 * Two things it deliberately does not do:
 *  - **It does not record rejections that are not the scheduler's.** An anonymous GET
 *    to `/api/sync` is a stranger knocking, not an incident, and writing a row for each
 *    would let anyone fill the table and bury the real history.
 *  - **It does not repeat itself.** `x-vercel-cron` is a plain header and anyone can
 *    send it, so an identical rejection inside the last hour is left alone. That caps
 *    the damage from a forged header at twenty-four rows a day while still recording the
 *    once-a-day event this exists for.
 *
 * Never throws. This runs on the failure path of the failure path; a broken diagnostic
 * must not change the answer the caller gets.
 */
export async function recordRejectedCron(
  request: NextRequest,
  denial: { reason: string; status: number },
  now: Date = new Date(),
): Promise<boolean> {
  if (!looksLikeVercelCron(request)) return false

  const message = `${REJECTED_CRON_PREFIX}: ${denial.reason} (HTTP ${denial.status})`

  try {
    const db = supabaseAdmin()

    const { data: recent } = await db
      .from('sync_runs')
      .select('id')
      .eq('source', 'all')
      .eq('trigger', 'cron')
      .eq('status', 'error')
      .eq('error', message)
      .gte('started_at', new Date(now.getTime() - REJECTION_DEDUPE_MS).toISOString())
      .limit(1)
    if ((recent ?? []).length > 0) return false

    const { error } = await db.from('sync_runs').insert({
      source: 'all',
      mode: 'incremental',
      trigger: 'cron',
      status: 'error',
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
      duration_ms: 0,
      error: message,
      stats: { rejected: 1, http_status: denial.status },
    })
    return !error
  } catch {
    return false
  }
}
