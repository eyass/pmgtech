import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { dedupeByConflictKey } from '@/lib/sync/matching'
import { STALE_RUN_AFTER_MS } from '@/lib/trust'

export type SyncSource = 'gitlab' | 'jira' | 'hibob' | 'all'
export type SyncMode = 'incremental' | 'backfill'
export type SyncTrigger = 'manual' | 'cron' | 'api'

export interface SyncStats {
  [key: string]: number | string | null
}

/**
 * Wraps a sync in a sync_runs row so the admin screen can show what happened,
 * how long it took, and what broke — including for runs that failed halfway.
 */
export class SyncContext {
  readonly db: SupabaseClient
  private runId: string | null = null
  private readonly logLines: { at: string; message: string }[] = []
  private readonly startedAt = Date.now()
  private readonly deadlineAt: number

  constructor(
    readonly source: SyncSource,
    readonly mode: SyncMode,
    readonly trigger: SyncTrigger,
    /**
     * Wall-clock budget in ms. A full backfill costs several API calls per merge
     * request and will not finish inside a serverless invocation, so syncs stop
     * cleanly when the budget runs out and resume from their cursors on the next
     * run rather than being killed mid-write.
     */
    budgetMs = 240_000,
  ) {
    this.db = supabaseAdmin()
    this.deadlineAt = Date.now() + budgetMs
  }

  /** True once the time budget is spent and the sync should wind down. */
  get outOfTime(): boolean {
    return Date.now() >= this.deadlineAt
  }

  get remainingMs(): number {
    return Math.max(0, this.deadlineAt - Date.now())
  }

  async start(): Promise<void> {
    const { data, error } = await this.db
      .from('sync_runs')
      .insert({
        source: this.source,
        mode: this.mode,
        trigger: this.trigger,
        status: 'running',
      })
      .select('id')
      .single()

    if (error) throw new Error(`Could not open sync run: ${error.message}`)
    this.runId = (data as { id: string }).id
  }

  log(message: string): void {
    this.logLines.push({ at: new Date().toISOString(), message })
    // Surfaces in Vercel function logs, which is where you look when a cron run
    // times out rather than fails.
    console.log(`[sync:${this.source}] ${message}`)
  }

  async finish(status: 'success' | 'partial' | 'error', stats: SyncStats, error?: unknown) {
    if (!this.runId) return
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : error ? String(error) : null

    await this.db
      .from('sync_runs')
      .update({
        status,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - this.startedAt,
        stats,
        error: message?.slice(0, 2000) ?? null,
        log: this.logLines.slice(-200),
      })
      .eq('id', this.runId)
  }

  // --- incremental cursors ----------------------------------------------------

  async getCursor(key: string): Promise<string | null> {
    const { data } = await this.db
      .from('sync_cursors')
      .select('value')
      .eq('source', this.source)
      .eq('key', key)
      .maybeSingle()
    return (data as { value: string | null } | null)?.value ?? null
  }

  async setCursor(key: string, value: string): Promise<void> {
    await this.db.from('sync_cursors').upsert(
      { source: this.source, key, value, updated_at: new Date().toISOString() },
      { onConflict: 'source,key' },
    )
  }

  /**
   * Where to resume from. On an incremental run this is the stored cursor minus
   * a small overlap so an event written during the previous run is not skipped;
   * on a backfill it is the configured window.
   */
  async since(key: string, backfillMonths: number, overlapMinutes = 30): Promise<string> {
    const cursor = this.mode === 'incremental' ? await this.getCursor(key) : null
    if (cursor) {
      return new Date(new Date(cursor).getTime() - overlapMinutes * 60_000).toISOString()
    }
    const from = new Date()
    from.setMonth(from.getMonth() - backfillMonths)
    return from.toISOString()
  }
}

/**
 * What an expired run's `error` column says. A constant so the trust page, a human
 * reading `/admin`, and this module cannot describe the same row three ways.
 */
export const ABANDONED_RUN_MESSAGE =
  'Abandoned: no terminal status was ever written. The invocation ended between start and finish — a timeout, an out-of-memory kill, or a process stopped by hand — so this run was closed by the next sync rather than by itself.'

/**
 * Close runs that never reported a result.
 *
 * `finish()` is the only writer of a terminal status, and it runs inside the same
 * invocation as the work. Anything that ends the invocation without unwinding —
 * exceeding `maxDuration`, an OOM kill, a local process interrupted — leaves the row
 * saying `running` for ever. Production held four such rows for three days, and they
 * did real damage beyond looking untidy: `readSourceHealth` treated them as a run in
 * flight, so a scheduler that had stopped firing altogether presented as a sync
 * mid-work.
 *
 * Called at the top of the sync route, which is the one place guaranteed to execute
 * before any new row is opened. Deliberately not called from `SyncContext.start()`:
 * three sources start three contexts per request and this only needs doing once.
 *
 * Writes `error` rather than `partial`, because `partial` is a designed outcome that
 * carries a cursor and a stats blob a later run can resume from, and an abandoned run
 * carries neither. Leaves `duration_ms` null on purpose — we never learned how long it
 * ran, and inventing "now minus started_at" would record the gap until the next sync
 * as though it were work.
 */
export async function expireAbandonedRuns(
  db: SupabaseClient,
  now: Date = new Date(),
  after: number = STALE_RUN_AFTER_MS,
): Promise<{ expired: number; sources: string[] }> {
  const cutoff = new Date(now.getTime() - after).toISOString()

  const { data, error } = await db
    .from('sync_runs')
    .select('id, source')
    .eq('status', 'running')
    .lt('started_at', cutoff)
  // A failure to tidy up must never stop the sync that was about to happen.
  if (error) return { expired: 0, sources: [] }

  const stale = (data ?? []) as { id: string; source: string }[]
  if (stale.length === 0) return { expired: 0, sources: [] }

  const { error: writeError } = await db
    .from('sync_runs')
    .update({
      status: 'error',
      finished_at: now.toISOString(),
      error: ABANDONED_RUN_MESSAGE,
    })
    .in(
      'id',
      stale.map((r) => r.id),
    )
  if (writeError) return { expired: 0, sources: [] }

  return { expired: stale.length, sources: [...new Set(stale.map((r) => r.source))].sort() }
}

/** Chunked upsert — Supabase rejects very large single payloads. */
export async function upsertInChunks(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  chunkSize = 500,
): Promise<number> {
  // Postgres refuses to touch the same row twice in one INSERT .. ON CONFLICT, so a
  // batch holding two rows with the same conflict key fails outright and takes the
  // sync down with it. See dedupeByConflictKey for why this cannot be left to callers.
  const deduped = dedupeByConflictKey(rows, onConflict)

  let written = 0
  for (let i = 0; i < deduped.length; i += chunkSize) {
    const chunk = deduped.slice(i, i + chunkSize)

    // Retry transient write failures. A backfill slice can be twenty-odd chunks and
    // every one is a chance for the connection to wobble — a single
    // "connection timeout" reaching the caller aborts the whole project and throws
    // away the slice. Constraint violations are not retryable and are recognisable
    // by their SQLSTATE (23xxx), so those still fail immediately rather than being
    // attempted five times.
    let lastMessage = ''
    let ok = false
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { error } = await db.from(table).upsert(chunk, { onConflict, ignoreDuplicates: false })
      if (!error) {
        ok = true
        break
      }
      lastMessage = error.message
      const permanent = typeof error.code === 'string' && /^(22|23|42)/.test(error.code)
      if (permanent || attempt === 4) break
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 250)
    }

    if (!ok) {
      throw new Error(`Upsert into ${table} failed (rows ${i}-${i + chunk.length}): ${lastMessage}`)
    }
    written += chunk.length
  }
  return written
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run tasks with a bounded concurrency. GitLab and Jira both rate-limit, so a
 * naive Promise.all over 60 projects gets throttled; four at a time keeps the
 * backfill fast without tripping limits.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ results: R[]; errors: { item: T; error: Error }[] }> {
  const results: R[] = []
  const errors: { item: T; error: Error }[] = []
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      try {
        results.push(await fn(items[index], index))
      } catch (error) {
        errors.push({ item: items[index], error: error as Error })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return { results, errors }
}
