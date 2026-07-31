import { NextResponse, type NextRequest } from 'next/server'

import { PERIODS, resolvePeriod, type PeriodKey } from '@/lib/queries'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { authoriseSync } from '@/lib/sync/auth'

/**
 * Score capture. Also the second Vercel Cron target.
 *
 * Every score in this app is recomputed from a date range at request time, so
 * without this endpoint the dashboard can say who is first today and can never say
 * whether they were first last month. `capture_score_snapshots` (0025) writes the
 * current engineer and squad scores down, stamped with the scoring formula's version
 * so a later reader can refuse to compare across a definition change.
 *
 * Shaped deliberately like `/api/sync`, including `maxDuration`: same two callers,
 * same authorisation, same failure semantics. The authorisation itself is
 * **imported** rather than re-implemented — a second copy of "is this Vercel Cron or
 * a signed-in admin" is a second copy that drifts, and the copy that drifts is
 * always the one guarding the endpoint nobody looks at.
 *
 * The RPC does the work and it is idempotent on `(subject, period, captured_for)`,
 * so a retried cron, a double-click on a manual run and a backfill of today all
 * replace the day rather than appending a duplicate. That is why this handler is
 * thin: there is exactly one definition of a score in this database, and the whole
 * design of the capture is that it calls that definition instead of restating it.
 *
 * Two things about the cron, recorded here because `vercel.json` cannot hold a
 * comment:
 *
 *  - **The schedule is `0 6 * * *`, three hours after the sync's `0 3 * * *`.** It
 *    runs after the sync so it records scores computed from the day's data rather
 *    than from yesterday's, and the gap is sized for Hobby's ±59 minutes of drift on
 *    both entries: worst case the sync fires at 03:59 and spends its whole 300s
 *    budget, finishing 04:04, while this can fire no earlier than 05:01.
 *  - **`/api/snapshots` is in `PUBLIC_PATHS` in `src/proxy.ts`.** Without it the
 *    session gate redirects the cron's bearer-token request to /login, which answers
 *    200, so Vercel records a successful run and no snapshot is ever written. That
 *    exclusion is not an opening: this handler authorises before it does anything.
 *
 * Query parameters:
 *   ?period=7d|30d|90d|180d|365d   which window to capture (default 90d)
 */
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/** What the RPC returns: one row per subject, with how many rows it wrote. */
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

  // An unknown period is refused rather than quietly resolved to 90d. `resolvePeriod`
  // falls back on purpose for a URL a person typed into the address bar, but a cron
  // capturing '90d' while its configuration says '30d' would write a mislabelled
  // series, and period_key is what keeps two windows from landing in one line.
  const requested = request.nextUrl.searchParams.get('period')
  if (requested !== null && !(requested in PERIODS)) {
    return NextResponse.json(
      {
        error: `Unknown period "${requested}"`,
        allowed: Object.keys(PERIODS),
      },
      { status: 400 },
    )
  }

  const { key, range } = resolvePeriod(requested ?? undefined)
  const periodKey: PeriodKey = key
  const trigger = caller.kind === 'cron' ? 'cron' : 'manual'

  const db = supabaseAdmin()
  const { data, error } = await db.rpc('capture_score_snapshots', {
    p_period_key: periodKey,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
  })

  if (error) {
    return NextResponse.json(
      { error: `capture_score_snapshots failed: ${error.message}`, period: periodKey, trigger },
      { status: 500 },
    )
  }

  const rows = (data ?? []) as CaptureRow[]
  const written = Object.fromEntries(rows.map((r) => [r.subject, r.rows_written]))

  // Read back the version that was stamped, rather than assuming it. A capture whose
  // response does not say which formula it recorded is a row nobody can place later.
  const { data: version } = await db.rpc('score_definition_version')

  return NextResponse.json({
    period: periodKey,
    window: { from: range.from.toISOString(), to: range.to.toISOString() },
    trigger,
    definitionVersion: (version as string | null) ?? null,
    written,
    note:
      Object.values(written).every((n) => n === 0)
        ? 'Nothing was written. The scoring RPCs returned no rows for this window, which usually means the sync has not run yet.'
        : undefined,
  })
}
