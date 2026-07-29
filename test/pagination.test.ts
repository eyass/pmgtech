import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  planCursorAdvance,
  planWindow,
  sortForWalk,
  wasTruncated,
  type WalkDirection,
} from '../src/lib/sync/pagination.ts'

/**
 * These tests exist because the same invariant was violated three times in this
 * codebase, each time reporting success while dropping history:
 *
 *   whichever end of a truncated listing the sort discards must be the end the
 *   cursor will resume from.
 *
 * The simulation at the bottom is the real guard. The unit tests above it pin the
 * specific historical regressions so they cannot come back individually.
 */

// --- a fake paged API ---------------------------------------------------------

interface Record_ {
  id: number
  updated_at: string
}

/** N records, one per hour, oldest first. */
function makeRecords(count: number, startIso = '2026-01-01T00:00:00.000Z'): Record_[] {
  const start = Date.parse(startIso)
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    updated_at: new Date(start + i * 3_600_000).toISOString(),
  }))
}

/**
 * Stands in for GitLab: filters by window, sorts, and truncates at the page limit —
 * which is exactly the behaviour that made the bug invisible.
 */
function fetchPage(
  all: Record_[],
  opts: { since: string; updatedBefore?: string; sort: 'asc' | 'desc'; pageLimit: number },
): Record_[] {
  const from = Date.parse(opts.since)
  const to = opts.updatedBefore ? Date.parse(opts.updatedBefore) : Number.POSITIVE_INFINITY
  const matching = all.filter((r) => {
    const at = Date.parse(r.updated_at)
    return at >= from && at < to
  })
  matching.sort((a, b) =>
    opts.sort === 'desc'
      ? b.updated_at.localeCompare(a.updated_at)
      : a.updated_at.localeCompare(b.updated_at),
  )
  return matching.slice(0, opts.pageLimit)
}

/**
 * Drive repeated slices the way the sync loop does, and report what was seen.
 * `brokenSort` reproduces the original bug: descending fetch with a forward cursor.
 */
function walk(opts: {
  all: Record_[]
  direction: WalkDirection
  pageLimit: number
  windowStart: Date
  maxSlices?: number
  brokenSort?: 'asc' | 'desc'
}) {
  const seen = new Map<number, number>()
  let backwardFrontier: string | null = null
  let forwardCursor: string | null = null
  let slices = 0
  let complete = false

  for (let i = 0; i < (opts.maxSlices ?? 200); i++) {
    slices++
    const plan = planWindow({
      direction: opts.direction,
      windowStart: opts.windowStart,
      backwardFrontier,
      forwardCursor,
      overlapMinutes: 0,
    })

    const batch = fetchPage(opts.all, {
      since: plan.since,
      updatedBefore: plan.updatedBefore,
      sort: opts.brokenSort ?? plan.sort,
      pageLimit: opts.pageLimit,
    })
    if (batch.length === 0) {
      complete = true
      break
    }

    const ordered = sortForWalk(batch, opts.direction)
    for (const r of ordered) seen.set(r.id, (seen.get(r.id) ?? 0) + 1)

    const truncated = wasTruncated(batch.length, opts.pageLimit)
    const advance = planCursorAdvance({
      direction: opts.direction,
      lastProcessed: ordered.at(-1)?.updated_at ?? null,
      truncated,
      processedWholeBatch: true,
    })
    if (advance.backwardFrontier !== null) backwardFrontier = advance.backwardFrontier
    if (advance.forwardCursor !== null) forwardCursor = advance.forwardCursor
    if (advance.reachedWindowStart) {
      complete = true
      break
    }
  }

  return { seen, slices, complete }
}

// --- the invariant ------------------------------------------------------------

describe('paged walk covers the whole window', () => {
  const windowStart = new Date('2025-12-01T00:00:00.000Z')

  for (const direction of ['forward', 'backward'] as WalkDirection[]) {
    it(`${direction}: every record is fetched even when every page is truncated`, () => {
      const all = makeRecords(1_000)
      const { seen, complete } = walk({ all, direction, pageLimit: 100, windowStart })

      assert.equal(seen.size, all.length, 'every record should be seen at least once')
      const missing = all.filter((r) => !seen.has(r.id)).map((r) => r.id)
      assert.deepEqual(missing, [], 'no record may be skipped')
      assert.ok(complete, 'the walk should terminate by itself')
    })

    it(`${direction}: terminates without re-reading the whole window each slice`, () => {
      const all = makeRecords(500)
      const { slices } = walk({ all, direction, pageLimit: 100, windowStart })
      // 500 records at 100 a slice needs ~5, plus a terminating one. A cursor that
      // fails to advance would spin to the cap instead.
      assert.ok(slices <= 8, `expected roughly 6 slices, got ${slices}`)
    })
  }

  it('handles a window smaller than one page', () => {
    const all = makeRecords(12)
    const { seen, complete, slices } = walk({
      all,
      direction: 'backward',
      pageLimit: 100,
      windowStart,
    })
    assert.equal(seen.size, 12)
    assert.ok(complete)
    assert.equal(slices, 1, 'a short first page proves the window is covered')
  })

  it('handles an empty window', () => {
    const { seen, complete } = walk({
      all: [],
      direction: 'backward',
      pageLimit: 100,
      windowStart,
    })
    assert.equal(seen.size, 0)
    assert.ok(complete)
  })
})

// --- the historical regressions ----------------------------------------------

describe('regressions', () => {
  const windowStart = new Date('2025-12-01T00:00:00.000Z')

  it('a descending fetch with a forward cursor loses the oldest records', () => {
    // This is the original merge-request bug, kept as a test so the failure mode is
    // documented and provably no longer what the planner produces.
    const all = makeRecords(1_000)
    const { seen } = walk({
      all,
      direction: 'forward',
      brokenSort: 'desc',
      pageLimit: 100,
      windowStart,
    })
    assert.ok(
      seen.size < all.length,
      'the broken combination must demonstrably lose records, otherwise this test proves nothing',
    )
    assert.ok(!seen.has(0), 'the oldest record is exactly what gets dropped')
  })

  it('the planner never pairs forward with descending', () => {
    const plan = planWindow({ direction: 'forward', windowStart, forwardCursor: null })
    assert.equal(plan.sort, 'asc')
  })

  it('the planner never pairs backward with ascending', () => {
    const plan = planWindow({ direction: 'backward', windowStart })
    assert.equal(plan.sort, 'desc')
  })

  it('a truncated forward batch does not advance the cursor to now', () => {
    // The deployment bug: advancing to now() declared everything up to the present as
    // captured, so the records beyond the page limit were never requested again.
    const advance = planCursorAdvance({
      direction: 'forward',
      lastProcessed: '2026-01-05T00:00:00.000Z',
      truncated: true,
      processedWholeBatch: true,
    })
    assert.equal(advance.forwardCursor, '2026-01-05T00:00:00.000Z')
    assert.equal(advance.reachedWindowStart, false)
  })

  it('an untruncated forward batch may advance to now', () => {
    const now = new Date('2026-02-01T12:00:00.000Z')
    const advance = planCursorAdvance({
      direction: 'forward',
      lastProcessed: '2026-01-05T00:00:00.000Z',
      truncated: false,
      processedWholeBatch: true,
      now,
    })
    assert.equal(advance.forwardCursor, now.toISOString())
    assert.equal(advance.reachedWindowStart, true)
  })

  it('a batch abandoned part-way does not advance to now even when untruncated', () => {
    const advance = planCursorAdvance({
      direction: 'forward',
      lastProcessed: '2026-01-05T00:00:00.000Z',
      truncated: false,
      processedWholeBatch: false,
    })
    assert.equal(advance.forwardCursor, '2026-01-05T00:00:00.000Z')
    assert.equal(advance.reachedWindowStart, false)
  })

  it('a truncated backward batch is not treated as reaching the window start', () => {
    const advance = planCursorAdvance({
      direction: 'backward',
      lastProcessed: '2026-01-05T00:00:00.000Z',
      truncated: true,
      processedWholeBatch: true,
    })
    assert.equal(advance.backwardFrontier, '2026-01-05T00:00:00.000Z')
    assert.equal(advance.reachedWindowStart, false)
  })

  it('the backward frontier only ever moves towards the past', () => {
    const all = makeRecords(400)
    let frontier: string | null = null
    const seenFrontiers: string[] = []

    for (let i = 0; i < 10; i++) {
      const plan = planWindow({
        direction: 'backward',
        windowStart: new Date('2025-12-01T00:00:00.000Z'),
        backwardFrontier: frontier,
      })
      const batch = fetchPage(all, {
        since: plan.since,
        updatedBefore: plan.updatedBefore,
        sort: plan.sort,
        pageLimit: 100,
      })
      if (batch.length === 0) break
      const ordered = sortForWalk(batch, 'backward')
      const advance = planCursorAdvance({
        direction: 'backward',
        lastProcessed: ordered.at(-1)!.updated_at,
        truncated: wasTruncated(batch.length, 100),
        processedWholeBatch: true,
      })
      frontier = advance.backwardFrontier
      seenFrontiers.push(frontier!)
    }

    for (let i = 1; i < seenFrontiers.length; i++) {
      assert.ok(
        Date.parse(seenFrontiers[i]) < Date.parse(seenFrontiers[i - 1]),
        `frontier moved forward at step ${i}: ${seenFrontiers[i - 1]} -> ${seenFrontiers[i]}`,
      )
    }
  })

  it('a forward cursor predating a shortened window does not re-read outside it', () => {
    // BACKFILL_MONTHS can be reduced after a cursor was stored, which would otherwise
    // send the next run back further than the configured window.
    const windowStart2 = new Date('2026-06-01T00:00:00.000Z')
    const plan = planWindow({
      direction: 'forward',
      windowStart: windowStart2,
      forwardCursor: '2025-08-01T00:00:00.000Z',
      overlapMinutes: 30,
    })
    assert.equal(plan.since, windowStart2.toISOString())
  })
})

describe('sortForWalk', () => {
  it('orders along the direction of travel', () => {
    const records = makeRecords(3)
    assert.deepEqual(
      sortForWalk(records, 'forward').map((r) => r.id),
      [0, 1, 2],
    )
    assert.deepEqual(
      sortForWalk(records, 'backward').map((r) => r.id),
      [2, 1, 0],
    )
  })

  it('does not mutate its input', () => {
    const records = makeRecords(3)
    sortForWalk(records, 'backward')
    assert.deepEqual(
      records.map((r) => r.id),
      [0, 1, 2],
    )
  })
})

describe('wasTruncated', () => {
  it('is true only at or beyond the page limit', () => {
    assert.equal(wasTruncated(99, 100), false)
    assert.equal(wasTruncated(100, 100), true)
    assert.equal(wasTruncated(101, 100), true)
  })
})
