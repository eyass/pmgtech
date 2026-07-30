import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  commitsNeedingStats,
  parseChangesCount,
  resolveMrSize,
  sumCommitStats,
} from '../src/lib/sync/change-size.ts'

/**
 * These rules exist because the previous version of them failed silently. The sync
 * read a field GitLab does not return and fell through to `?? 0`, so every merge
 * request and every commit in the database recorded a size of zero and three metrics
 * built on them reported that nothing in the company's history had ever changed a
 * line. Nothing threw. The tests that matter here are therefore the ones asserting
 * that an absent measurement stays absent.
 */

describe('parseChangesCount', () => {
  it('reads a plain count', () => {
    assert.equal(parseChangesCount('12'), 12)
    assert.equal(parseChangesCount(' 3 '), 3)
    assert.equal(parseChangesCount('0'), 0)
  })

  it('takes GitLab’s capped form at face value', () => {
    // Very large merge requests come back as "1000+"; 1000 files is past every
    // threshold in this app, so the cap is not worth chasing.
    assert.equal(parseChangesCount('1000+'), 1000)
  })

  it('returns null rather than 0 for anything it cannot read', () => {
    for (const value of [undefined, null, '', 'many', 'a lot', '12 files']) {
      assert.equal(parseChangesCount(value), null, `${JSON.stringify(value)} should be null`)
    }
  })
})

describe('sumCommitStats', () => {
  it('sums commits that all reported stats', () => {
    assert.deepEqual(
      sumCommitStats([
        { stats: { additions: 10, deletions: 2 } },
        { stats: { additions: 5, deletions: 1 } },
      ]),
      { additions: 15, deletions: 3 },
    )
  })

  it('refuses a partial sum, because an understatement hides where a gap shows', () => {
    // Half the commits measured would make a large merge request look small, and
    // nothing downstream could tell. A null is visible in sized_mr_pct.
    assert.equal(
      sumCommitStats([{ stats: { additions: 10, deletions: 2 } }, {}]),
      null,
    )
  })

  it('returns null when nothing was measured or there are no commits', () => {
    assert.equal(sumCommitStats([]), null)
    assert.equal(sumCommitStats(undefined), null)
    assert.equal(sumCommitStats([{}, {}]), null)
    assert.equal(sumCommitStats([{ stats: null }]), null)
  })
})

describe('resolveMrSize', () => {
  it('prefers the instance’s own diff stats', () => {
    const size = resolveMrSize({
      diffStats: { additions: 100, deletions: 20, file_count: 7 },
      changesCount: '9',
      commits: [{ stats: { additions: 1, deletions: 1 } }],
    })
    assert.equal(size.source, 'diff_stats')
    assert.equal(size.additions, 100)
    assert.equal(size.deletions, 20)
    assert.equal(size.changedFiles, 7)
    assert.equal(size.churnKnown, true)
  })

  it('falls back to the sum of commits, which is the case that actually fires here', () => {
    const size = resolveMrSize({
      changesCount: '4',
      commits: [
        { stats: { additions: 30, deletions: 5 } },
        { stats: { additions: 10, deletions: 0 } },
      ],
    })
    assert.equal(size.source, 'commits_sum')
    assert.equal(size.additions, 40)
    assert.equal(size.deletions, 5)
    assert.equal(size.changedFiles, 4)
    assert.equal(size.churnKnown, true)
  })

  it('reports a file count without claiming to know the line count', () => {
    const size = resolveMrSize({ changesCount: '6', commits: [{}] })
    assert.equal(size.source, 'changes_count')
    assert.equal(size.changedFiles, 6)
    // The important assertion of this file: 0 additions is not a measurement, and
    // churnKnown false is what keeps it out of every complexity figure.
    assert.equal(size.churnKnown, false)
  })

  it('says unavailable when no source answered', () => {
    const size = resolveMrSize({})
    assert.equal(size.source, 'unavailable')
    assert.equal(size.churnKnown, false)
    assert.equal(size.additions, 0)
  })

  it('does not treat the old diff_stats shape as present when it is absent', () => {
    // The exact bug: `mr.diff_stats` undefined, `?? 0` fires, zero is stored as fact.
    for (const diffStats of [undefined, null, {}]) {
      const size = resolveMrSize({ diffStats, commits: [{}] })
      assert.notEqual(size.source, 'diff_stats')
      assert.equal(size.churnKnown, false)
    }
  })
})

describe('commitsNeedingStats', () => {
  const commits = [
    { id: 'a', stats: { additions: 1, deletions: 0 } },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
  ]

  it('asks only for the commits that lack a size', () => {
    assert.deepEqual(
      commitsNeedingStats(commits, 10).map((c) => c.id),
      ['b', 'c', 'd'],
    )
  })

  it('caps the work so one branch cannot spend a whole run', () => {
    assert.deepEqual(
      commitsNeedingStats(commits, 2).map((c) => c.id),
      ['b', 'c'],
    )
    assert.deepEqual(commitsNeedingStats(commits, 0), [])
  })
})
