import { NextResponse, type NextRequest } from 'next/server'

import { PERIODS, resolvePeriod, type PeriodKey } from '@/lib/queries'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { authoriseSync } from '@/lib/sync/auth'

/**
 * Score snapshot capture. Also a Vercel Cron target.
 *
 * `0025_score_snapshots.sql` built the tables and `capture_score_snapshots`, then
 * recorded that the route calling it did not survive the worktree it was written
 * in. Nothing has called it since: the tables held one capture, from 2026-07-31,
 * and every score on every page was recomputed from scratch with no history behind
 * it. This is that route rebuilt.
 *
 * Why it is separate from `/api/sync` rather than tacked onto the end of it:
 *
 * - **A snapshot of a half-finished sync is worse than no snapshot.** `/api/sync`
 *   deliberately continues when one integration fails, and it can exhaust its
 *   300-second budget mid-source. Capturing inside it would write scores computed
 *   from whatever happened to have landed, stamped with a date implying they were
 *   the day's real numbers. Two endpoints on two schedules means the capture reads
 *   a settled database.
 * - **They fail independently.** A GitLab outage should not cost a day of history,
 *   and a capture error should not mark the sync as failed.
 *
 * The cron runs at 03:30, half an hour after the 03:00 sync, which is comfortably
 * more than the sync's own 300-second ceiling.
 *
 * Query parameters:
 *   ?period=90d|30d|...|all   which window(s) to capture (default 30d and 90d)
 */
export const maxDuration = 120
export const dynamic = 'force-dynamic'

/**
 * Captured by default. Both are windows people actually quote — 90d is the app's
 * default period and 30d is what a monthly review asks for. The other three are
 * available on request but not captured nightly: '7d' is too noisy to trend, and
 * '180d'/'365d' move so slowly that a daily row is almost entirely redundant with
 * yesterday's.
 */
const DEFAULT_PERIODS: PeriodKey[] = ['30d', '90d']

type CaptureRow = { subject: string; rows_written: number }

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  const caller = await authoriseSync(request)
  if (caller.kind === 'denied') {
    return NextResponse.json({ error: caller.reason }, { status: caller.status })
  }

  const requested = request.nextUrl.searchParams.get('period')

  let periods: PeriodKey[]
  if (!requested) {
    periods = DEFAULT_PERIODS
  } else if (requested === 'all') {
    periods = Object.keys(PERIODS) as PeriodKey[]
  } else if (requested in PERIODS) {
    periods = [requested as PeriodKey]
  } else {
    return NextResponse.json(
      { error: `Unknown period "${requested}"`, known: [...Object.keys(PERIODS), 'all'] },
      { status: 400 },
    )
  }

  const db = supabaseAdmin()
  const captured: Record<string, CaptureRow[]> = {}
  const failures: Record<string, string> = {}

  for (const period of periods) {
    // resolvePeriod anchors on now(), which is what a nightly capture wants: the
    // window ending today. capture_score_snapshots derives captured_for from the
    // upper bound, so a re-run on the same day updates that day's row instead of
    // adding a second one.
    const { range } = resolvePeriod(period)

    const { data, error } = await db.rpc('capture_score_snapshots', {
      p_period_key: period,
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
    })

    if (error) {
      // One bad period should not cost the others. The response says which failed.
      failures[period] = error.message
      continue
    }

    captured[period] = (data ?? []) as CaptureRow[]
  }

  const anyCaptured = Object.keys(captured).length > 0

  return NextResponse.json(
    {
      trigger: caller.kind === 'cron' ? 'cron' : 'manual',
      captured,
      failures: Object.keys(failures).length > 0 ? failures : undefined,
    },
    { status: anyCaptured ? 200 : 500 },
  )
}
