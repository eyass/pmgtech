/**
 * Working out how large a change actually was.
 *
 * This is its own module, free of imports, because getting it wrong is silent. The
 * previous version read `mr.diff_stats` — a field GitLab's REST merge-request
 * endpoint does not return — and fell through to `?? 0`, so 2,000 merge requests
 * and 9,893 commits recorded a size of zero and three metrics built on them
 * (large_mr_pct, median_mr_churn, squad code_churn) read as if every change in the
 * company's history were empty. Nothing failed, nothing was logged, and the numbers
 * looked plausible.
 *
 * Two rules follow from that, and both are enforced here rather than left to the
 * caller:
 *
 *   1. Never invent a zero. Every result carries the source it came from, and
 *      "nobody could tell me" is `unavailable` rather than 0. The database keeps
 *      `size_source` null until something measures the row, and the views expose
 *      churn as NULL for those, so a metric withholds itself instead of reporting
 *      an empty change.
 *   2. Never assume a field is present. Each source is probed and checked, in
 *      descending order of trust, and the one that answered is recorded.
 */

/** Where a size came from, in descending order of how much it can be trusted. */
export type MrSizeSource = 'diff_stats' | 'commits_sum' | 'changes_count' | 'unavailable'
export type CommitSizeSource = 'list_stats' | 'commit_api' | 'unavailable'

export interface CommitStats {
  additions: number
  deletions: number
}

export interface MrSizeInput {
  /** Present only if the instance returns it; not assumed. */
  diffStats?: { additions?: number; deletions?: number; file_count?: number } | null
  /** `changes_count` from the merge-request payload: a file count, as a string. */
  changesCount?: string | null
  /** Commits on the merge request, each with stats if anything supplied them. */
  commits?: { stats?: CommitStats | null }[]
}

export interface ResolvedMrSize {
  additions: number
  deletions: number
  changedFiles: number
  source: MrSizeSource
  /** False when only a file count is known and the line counts are still unknown. */
  churnKnown: boolean
}

/**
 * GitLab reports a merge request's file count as a string, and caps it: a very
 * large change comes back as "1000+" rather than a number. The cap is taken at
 * face value — 1000 files is past every threshold this app has anyway — and
 * anything unparseable is null rather than 0, because "I cannot read this" and
 * "no files changed" are different facts.
 */
export function parseChangesCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const match = /^(\d+)\+?$/.exec(value.trim())
  if (!match) return null
  return Number(match[1])
}

/** Sum of the commits that reported stats, or null if none of them did. */
export function sumCommitStats(
  commits: { stats?: CommitStats | null }[] | undefined,
): CommitStats | null {
  if (!commits || commits.length === 0) return null
  let additions = 0
  let deletions = 0
  let measured = 0
  for (const commit of commits) {
    if (!commit.stats) continue
    additions += commit.stats.additions ?? 0
    deletions += commit.stats.deletions ?? 0
    measured += 1
  }
  // Partial coverage is refused rather than summed. Half a merge request's commits
  // is an understatement of its size, and an understatement is worse than a gap:
  // the gap is visible in sized_mr_pct, the understatement is not visible anywhere.
  if (measured === 0 || measured < commits.length) return null
  return { additions, deletions }
}

/**
 * How big was this merge request?
 *
 * Order of trust: the instance's own diff stats if it returns them, then the sum of
 * its commits' line counts, then the file count alone, then nothing. Summed commits
 * are a slight overstatement — a branch that rewrites the same lines twice counts
 * them twice — which is acceptable for a size proxy and is why they rank below
 * diff stats rather than above.
 */
export function resolveMrSize(input: MrSizeInput): ResolvedMrSize {
  const files = parseChangesCount(input.changesCount)

  const diff = input.diffStats
  if (diff && (diff.additions !== undefined || diff.deletions !== undefined)) {
    return {
      additions: diff.additions ?? 0,
      deletions: diff.deletions ?? 0,
      changedFiles: diff.file_count ?? files ?? 0,
      source: 'diff_stats',
      churnKnown: true,
    }
  }

  const summed = sumCommitStats(input.commits)
  if (summed) {
    return {
      additions: summed.additions,
      deletions: summed.deletions,
      changedFiles: files ?? 0,
      source: 'commits_sum',
      churnKnown: true,
    }
  }

  if (files !== null) {
    return {
      additions: 0,
      deletions: 0,
      changedFiles: files,
      source: 'changes_count',
      churnKnown: false,
    }
  }

  return { additions: 0, deletions: 0, changedFiles: 0, source: 'unavailable', churnKnown: false }
}

/**
 * Which commits still need a line count fetched for them, capped.
 *
 * The cap exists because one merge request must not consume a whole run: a branch
 * with two hundred commits would cost two hundred API calls and stall the walk that
 * every other metric depends on. Uncapped work here is paid for by the next run
 * instead, which is the same bargain the rest of this sync makes.
 */
export function commitsNeedingStats<T extends { id: string; stats?: CommitStats | null }>(
  commits: T[],
  limit: number,
): T[] {
  if (limit <= 0) return []
  return commits.filter((commit) => !commit.stats).slice(0, limit)
}
