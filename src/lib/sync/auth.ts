import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'

import { appEnv } from '@/lib/env'
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
