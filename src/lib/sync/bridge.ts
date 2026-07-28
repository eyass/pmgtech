import type { SupabaseClient } from '@supabase/supabase-js'

import {
  classifyBridgeCandidate,
  type BridgeCandidate,
  type BridgeVerdict,
} from '@/lib/sync/matching'

/**
 * The commit bridge: recover GitLab-account-to-engineer links from the commits inside
 * each account's merge requests.
 *
 * GitLab hands us a numeric author id and, for most accounts here, no email, so the
 * email-only resolver has nothing to work with and 46% of merged merge requests are
 * attributed to nobody. The commits do carry emails. See matching.ts for why the
 * evidence is measured per merge request rather than in aggregate, and for the three
 * conditions that have to hold before a link is written without anyone looking at it.
 */

export interface BridgeRow extends BridgeCandidate {
  commits: number
  verdict: BridgeVerdict
}

export interface BridgeResult {
  candidates: BridgeRow[]
  /** Links written. */
  linked: number
  /** Historical rows re-attributed as a result. */
  reattributed: number
}

const SOURCES = [
  { rpc: 'commit_bridge_candidates', kind: 'commit-email' as const },
  { rpc: 'jira_bridge_candidates', kind: 'issue-author' as const },
]

export async function loadBridgeCandidates(db: SupabaseClient): Promise<BridgeRow[]> {
  const out: BridgeRow[] = []

  for (const source of SOURCES) {
    const { data, error } = await db.rpc(source.rpc)
    if (error) throw new Error(`${source.rpc} failed: ${error.message}`)

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const candidate: BridgeCandidate & { commits: number } = {
        provider: String(row.provider ?? 'gitlab'),
        externalId: String(row.external_id ?? ''),
        displayName: (row.display_name as string | null) ?? null,
        handle: (row.handle as string | null) ?? null,
        email: String(row.email ?? ''),
        kind: source.kind,
        mrsWon: Number(row.mrs_won ?? 0),
        mrs: Number(row.mrs ?? 0),
        commits: Number(row.commits ?? 0),
        engineerId: (row.engineer_id as string | null) ?? null,
        engineerName: (row.engineer_name as string | null) ?? null,
      }
      out.push({ ...candidate, verdict: classifyBridgeCandidate(candidate) })
    }
  }

  return out
}

/**
 * Apply the links the evidence supports on its own, and return everything else for a
 * human to look at.
 *
 * `dryRun` exists because the first thing anyone sensibly wants from a rule that rewrites
 * attribution across tens of thousands of rows is to see what it would do.
 */
export async function runCommitBridge(
  db: SupabaseClient,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<BridgeResult> {
  const candidates = await loadBridgeCandidates(db)
  const confident = candidates.filter((c) => c.verdict.action === 'link')

  if (dryRun || confident.length === 0) {
    return { candidates, linked: 0, reattributed: 0 }
  }

  const rows = confident.map((c) => ({
    engineer_id: (c.verdict as { engineerId: string }).engineerId,
    provider: c.provider,
    external_id: c.externalId,
    external_handle: c.handle ?? c.displayName ?? null,
  }))

  const { error: insertError } = await db
    .from('engineer_identities')
    .upsert(rows, { onConflict: 'provider,external_id' })
  if (insertError) throw new Error(`Bridge could not write identities: ${insertError.message}`)

  // Re-attribution is what actually moves the numbers: the identity rows only tell future
  // syncs what to do, while the history already in the database still points at nobody.
  const { data: stats, error: rpcError } = await db.rpc('reattribute_from_identities')
  if (rpcError) throw new Error(`Bridge could not re-attribute: ${rpcError.message}`)

  const counts = (stats ?? {}) as Record<string, number>
  const reattributed = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)

  // The triage list is keyed on these accounts still being unknown, so clear the ones we
  // have just answered rather than leaving them to be linked a second time by hand.
  for (const provider of new Set(confident.map((c) => c.provider))) {
    await db
      .from('unmatched_identities')
      .delete()
      .eq('provider', provider)
      .in(
        'external_id',
        confident.filter((c) => c.provider === provider).map((c) => c.externalId),
      )
  }

  return { candidates, linked: confident.length, reattributed }
}
