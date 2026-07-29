/**
 * Windowing and cursor arithmetic for paged, resumable syncs.
 *
 * Deliberately free of imports so it can be unit-tested directly. The rules here
 * are the ones this codebase got wrong three separate times — in merge requests, in
 * deployments and in pipelines — each time in a way that reported success while
 * silently dropping history:
 *
 *   THE INVARIANT: a listing is truncated at a page limit, so whichever end of the
 *   window the sort discards must be the end the cursor will resume from.
 *
 * Walking forward from the oldest record therefore needs ascending order, so the
 * truncation falls at the recent end where the forward cursor picks up. Walking
 * backward from the newest needs descending order plus an updatedBefore frontier, so
 * the truncation falls at the old end where the backward frontier picks up. Getting
 * this backwards means the discarded records end up on the far side of the cursor and
 * are never requested again.
 *
 * The second rule is subtler and cost a full day of deployment history: the forward
 * cursor may only jump to "now" when the result was NOT truncated. Doing it
 * unconditionally declares everything up to the present as captured.
 */

export type WalkDirection = 'forward' | 'backward'

export interface WindowRequest {
  direction: WalkDirection
  /** Start of the configured backfill window. */
  windowStart: Date
  /** How far back a previous backward pass reached, if any. */
  backwardFrontier?: string | null
  /** High-water mark from a previous forward pass, if any. */
  forwardCursor?: string | null
  /** Re-read a little before the forward cursor, so an in-flight write is not missed. */
  overlapMinutes?: number
  now?: Date
}

export interface WindowPlan {
  /** updated_after bound. */
  since: string
  /** updated_before bound, only used walking backward. */
  updatedBefore: string | undefined
  sort: 'asc' | 'desc'
}

/**
 * The bounds and sort order for the next request.
 *
 * Note the sort is derived from the direction rather than passed in — the two cannot
 * disagree without reintroducing the bug this module exists to prevent.
 */
export function planWindow(request: WindowRequest): WindowPlan {
  const now = request.now ?? new Date()

  if (request.direction === 'backward') {
    return {
      since: request.windowStart.toISOString(),
      updatedBefore: request.backwardFrontier ?? undefined,
      sort: 'desc',
    }
  }

  const overlapMs = (request.overlapMinutes ?? 30) * 60_000
  if (request.forwardCursor) {
    const from = new Date(new Date(request.forwardCursor).getTime() - overlapMs)
    // Never re-read from before the window; the cursor can predate a shortened window.
    const floor = request.windowStart
    return {
      since: (from < floor ? floor : from).toISOString(),
      updatedBefore: undefined,
      sort: 'asc',
    }
  }

  void now
  return { since: request.windowStart.toISOString(), updatedBefore: undefined, sort: 'asc' }
}

/** True when a listing came back at its page limit, meaning more exists beyond it. */
export function wasTruncated(returned: number, pageLimit: number): boolean {
  return returned >= pageLimit
}

/**
 * Order a batch along the direction of travel, so a cursor written mid-run always
 * describes a contiguous span rather than an arbitrary subset.
 */
export function sortForWalk<T extends { updated_at: string }>(
  records: T[],
  direction: WalkDirection,
): T[] {
  const sorted = [...records]
  sorted.sort((a, b) =>
    direction === 'backward'
      ? b.updated_at.localeCompare(a.updated_at)
      : a.updated_at.localeCompare(b.updated_at),
  )
  return sorted
}

export interface CursorAdvance {
  /** Write to the backward frontier, or null to leave it. */
  backwardFrontier: string | null
  /** Write to the forward cursor, or null to leave it. */
  forwardCursor: string | null
  /** True when the backward pass has provably reached the window start. */
  reachedWindowStart: boolean
}

/**
 * What to write after processing a batch.
 *
 * `lastProcessed` is the updated_at of the final record handled, which — because the
 * batch is sorted along the direction of travel — is the oldest on a backward pass
 * and the newest on a forward one. Either way it is where the next run resumes.
 */
export function planCursorAdvance(input: {
  direction: WalkDirection
  lastProcessed: string | null
  truncated: boolean
  /** False when the run stopped early, e.g. out of time or on an error. */
  processedWholeBatch: boolean
  now?: Date
}): CursorAdvance {
  const { direction, lastProcessed, truncated, processedWholeBatch } = input
  const now = (input.now ?? new Date()).toISOString()

  if (direction === 'backward') {
    return {
      backwardFrontier: lastProcessed,
      forwardCursor: null,
      // Only a short batch that was fully processed proves there is nothing older.
      reachedWindowStart: processedWholeBatch && !truncated,
    }
  }

  // Forward. Jumping to now() is only safe when nothing was left behind: neither
  // truncated by the page limit nor abandoned mid-batch.
  if (!truncated && processedWholeBatch) {
    return { backwardFrontier: null, forwardCursor: now, reachedWindowStart: true }
  }
  return { backwardFrontier: null, forwardCursor: lastProcessed, reachedWindowStart: false }
}
