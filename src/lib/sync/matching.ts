/**
 * Name and value matching rules used by the sync.
 *
 * Import-free so it can be unit-tested directly. Every function here exists because
 * a naive version of it produced wrong numbers against real data.
 */

/**
 * Whether a GitLab environment name is production.
 *
 * A plain substring test is not enough: this org runs environments called
 * `nonprod-grafana-alloy-testing-*`, and "nonprod" contains "prod". Those were
 * flagged as production and stayed out of the DORA figures only because none had
 * reached a terminal status yet — the first successful one would have inflated deploy
 * frequency and skewed change failure rate.
 *
 * So a match must begin on a word boundary, and a preceding "non" negates it.
 * `prod-client-x` and `p4h-prod-server-x` qualify; `nonprod-x`, `non-prod-x` and
 * `reproduction-env` do not. A pattern followed by more letters is still fine —
 * "production" is production.
 */
export function isProductionEnvironment(name: string, patterns: string[]): boolean {
  const haystack = name.toLowerCase()
  return patterns.some((pattern) => {
    const needle = pattern.toLowerCase()
    if (needle.length === 0) return false
    for (let from = 0; ; ) {
      const idx = haystack.indexOf(needle, from)
      if (idx === -1) return false
      const precededByLetter = idx > 0 && /[a-z]/.test(haystack[idx - 1])
      const negated = /(^|[-_./])non$/.test(haystack.slice(0, idx).replace(/[-_./]$/, ''))
      if (!precededByLetter && !negated) return true
      from = idx + 1
    }
  })
}

/**
 * An ISO calendar date, or null.
 *
 * HiBob returns dates in the tenant's display format when asked for human-readable
 * values — "20/07/2026" — which Postgres rejects for a `date` column, and which
 * cannot be safely guessed either: "07/01/2025" is two different days depending on
 * locale, and picking one would put a wrong tenure on someone's profile. So anything
 * that is not already an ISO date is dropped rather than interpreted.
 */
export function asIsoDate(value: unknown): string | null {
  const raw =
    typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  if (raw.length === 0) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return null

  // Date.parse is not enough: it accepts "2025-02-31" and rolls it forward to 3 March,
  // so an impossible day passes a NaN check and lands in the database as a real but
  // wrong date. Round-tripping the components is what actually rejects it.
  const [, y, m, d] = match.map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d))
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) {
    return null
  }
  return raw
}

/**
 * Whether a person has actually left, given a termination date.
 *
 * A date in the future is a notice period, not a departure: HiBob reports it as
 * status Active with terminationDate set. Treating that as inactive drops the person
 * out of the engineer views and erases them from their squad's numbers weeks before
 * they go.
 */
export function hasLeft(terminationDate: unknown, now: Date = new Date()): boolean {
  const raw = typeof terminationDate === 'string' ? terminationDate : ''
  if (raw.length === 0) return false
  const at = Date.parse(raw)
  return !Number.isNaN(at) && at <= now.getTime()
}

/**
 * Deduplicate rows by the columns an upsert conflicts on, keeping the last occurrence.
 *
 * Postgres refuses to touch the same row twice in one INSERT .. ON CONFLICT, so a
 * batch holding two rows with the same key fails with "cannot affect row a second
 * time" and takes the whole sync down. Upstream APIs do repeat records — the same
 * GitLab pipeline appears under more than one ref, and paged listings overlap — so
 * this cannot be left to callers. Rows arrive in listing order, so the later one is
 * the fresher copy.
 */
export function dedupeByConflictKey<T extends Record<string, unknown>>(
  rows: T[],
  onConflict: string,
): T[] {
  const keyColumns = onConflict
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (keyColumns.length === 0) return [...rows]

  const byKey = new Map<string, T>()
  for (const row of rows) {
    byKey.set(JSON.stringify(keyColumns.map((c) => row[c] ?? null)), row)
  }
  return Array.from(byKey.values())
}

/** Whether a board name looks like one person's view rather than a team's board. */
export function isPersonalBoard(name: string, patterns: string[]): boolean {
  const n = name.toLowerCase()
  return patterns.some((p) => p.length > 0 && n.includes(p.toLowerCase()))
}

// --- commit bridge -----------------------------------------------------------------
//
// GitLab reports a merge request's author as a numeric user id and, for most accounts
// here, no email — so email-based resolution has nothing to work with and 46% of merged
// merge requests end up attributed to nobody. The commits inside those merge requests do
// carry author emails, and those emails do match engineers. Bridging the two recovers the
// attribution without guessing at names.
//
// The bridge is not simply "take the commit email", because an author can open a merge
// request full of somebody else's commits — a rebase, a cherry-pick, taking over an
// abandoned branch. In this instance the GitLab account `daria37` (display name "Daria
// Melnyk") has five merge requests whose commits are 63% authored by a completely
// different person's address. Aggregate commit share cannot tell that apart from a real
// link. Per-merge-request dominance can: it sits at 60% where every genuine case is
// above 88%.

/** An address belonging to machinery — a CI runner, a service account, a build bot. */
export function isMachineEmail(email: string): boolean {
  const e = email.toLowerCase().trim()
  return (
    e.endsWith('noreply.gitlab.com') ||
    e.endsWith('noreply.github.com') ||
    e.includes('service_account') ||
    /_bot_|(^|[-._])bot@|^ci@|^gitlab-ci/.test(e)
  )
}

/**
 * An address that cannot reach anyone — "norberthires@norberts-macbook-air.local", the
 * default git makes up when nobody sets user.email.
 *
 * Kept separate from isMachineEmail because the two need opposite handling: a service
 * account should be excluded from the metrics, while this is a real person whose commits
 * simply carry no usable address. Calling them a bot would delete their work from the
 * numbers, which is the failure mode this whole exercise exists to avoid.
 */
export function isUnroutableEmail(email: string): boolean {
  const e = email.toLowerCase().trim()
  return (
    !e.includes('@') ||
    e.endsWith('.local') ||
    e.endsWith('.localdomain') ||
    e.endsWith('.localhost') ||
    e.endsWith('@localhost')
  )
}

/** Strip diacritics and punctuation so "Kadłuczka" and "Kadluczka" compare equal. */
function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Polish ł has no combining form, so it survives NFD and needs its own mapping.
    .replace(/ł/gi, 'l')
    .replace(/ø/gi, 'o')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
}

/**
 * Whether two names share a substantial token.
 *
 * This never creates a link on its own — identity resolution stays email-only, because
 * two people called "J. Smith" merging silently is worse than a row left unmapped. It is
 * used only to corroborate a link the commit evidence already proposes, which is what
 * makes auto-applying safe: "Manolis Kypriotakis" and "Emmanouil Kypriotakis" agree on a
 * surname, while "Daria Melnyk" and "Eyass Shakrah" agree on nothing.
 */
export function sharesNameToken(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const left = new Set(nameTokens(a))
  if (left.size === 0) return false
  return nameTokens(b).some((token) => left.has(token))
}

export interface BridgeCandidate {
  provider: string
  externalId: string
  displayName: string | null
  handle: string | null
  /**
   * Dominant commit-author email across this account's merge requests. Empty for the Jira
   * bridge, whose evidence is not an address — see `kind`.
   */
  email: string
  /**
   * Which evidence produced this candidate:
   *  - 'commit-email': the emails on the commits inside the account's merge requests;
   *  - 'issue-author': who authored the merge requests that reference the issues this
   *    Jira account is assigned. Jira will not give us addresses at all — the REST
   *    `/user/email` endpoint answers "Requestor must be a whitelisted app (not a user)"
   *    for an API token — so this is the only evidence available for Jira, and it is
   *    evidence rather than a name guess.
   */
  kind: 'commit-email' | 'issue-author'
  /** Units in which the dominant party won (merge requests, or issues). */
  mrsWon: number
  /** Units considered in total. */
  mrs: number
  /** The engineer the evidence points at, if any. */
  engineerId: string | null
  engineerName: string | null
}

export type BridgeVerdict =
  | { action: 'link'; engineerId: string; confidence: number; reason: string }
  | { action: 'suggest-link'; engineerId: string; confidence: number; reason: string }
  | { action: 'suggest-bot'; reason: string }
  | { action: 'suggest-engineer'; reason: string }
  /** A real person whose commits carry no usable address — needs a human to say who. */
  | { action: 'suggest-manual'; reason: string }
  | { action: 'skip'; reason: string }

export const BRIDGE_MIN_MRS = 3
export const BRIDGE_AUTO_SHARE = 80

/**
 * What to do about one bridge candidate.
 *
 * Auto-applies only when all three hold: the dominant email belongs to a known engineer,
 * it dominates at least 80% of at least three merge requests, and the two names
 * corroborate. Anything weaker is surfaced for a human, who can see the same evidence.
 */
export function classifyBridgeCandidate(candidate: BridgeCandidate): BridgeVerdict {
  const share = candidate.mrs > 0 ? (100 * candidate.mrsWon) / candidate.mrs : 0
  const rounded = Math.round(share * 10) / 10
  const unit = candidate.kind === 'issue-author' ? 'issue' : 'merge request'
  const units = `${unit}${candidate.mrs === 1 ? '' : 's'}`

  // The address checks only apply to the commit bridge; the Jira bridge has no address to
  // check, because Atlassian will not give one out for an API token.
  if (candidate.kind === 'commit-email') {
    if (isMachineEmail(candidate.email)) {
      return {
        action: 'suggest-bot',
        reason: `commits are authored by ${candidate.email}, which no person owns`,
      }
    }
  }

  if (candidate.mrs < BRIDGE_MIN_MRS) {
    return { action: 'skip', reason: `only ${candidate.mrs} ${units} of evidence` }
  }

  if (candidate.kind === 'commit-email' && isUnroutableEmail(candidate.email)) {
    return {
      action: 'suggest-manual',
      reason: `commits come from ${candidate.email}, a local git config that cannot be matched to anyone — pick the person, or have them set user.email`,
    }
  }

  if (!candidate.engineerId) {
    return {
      action: 'suggest-engineer',
      reason: `${candidate.email} authors ${rounded}% of their ${units} but matches no engineer`,
    }
  }

  const namesAgree = sharesNameToken(candidate.displayName, candidate.engineerName)
  const evidence =
    candidate.kind === 'issue-author'
      ? `${candidate.engineerName} opened the merge requests for ${candidate.mrsWon} of the ${candidate.mrs} issues assigned to this account`
      : `${candidate.email} authors the most commits in ${candidate.mrsWon} of ${candidate.mrs} merge requests`

  if (rounded >= BRIDGE_AUTO_SHARE && namesAgree) {
    return {
      action: 'link',
      engineerId: candidate.engineerId,
      confidence: rounded,
      reason: `${evidence}, and the names agree`,
    }
  }

  return {
    action: 'suggest-link',
    engineerId: candidate.engineerId,
    confidence: rounded,
    reason: namesAgree
      ? `${evidence} — ${rounded}%, below the ${BRIDGE_AUTO_SHARE}% bar for linking without review`
      : `${evidence}, but that name does not match ${candidate.displayName ?? 'this account'}`,
  }
}
