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
