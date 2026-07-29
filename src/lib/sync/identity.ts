import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Identity resolution.
 *
 * HiBob is the source of truth for who exists. GitLab and Jira then need to be
 * tied to those people. Resolution order:
 *
 *   1. An explicit row in engineer_identities (set by a previous sync or by hand)
 *   2. Email match against engineers.email or an 'email' identity
 *   3. Nothing — the identity is recorded in unmatched_identities for triage
 *
 * We deliberately do not fuzzy-match on display names. Two engineers called
 * "J. Smith" would silently merge, and attributing one person's work to another
 * is far worse than leaving a row unmapped.
 */

export type Provider = 'gitlab' | 'jira'

interface ResolvableIdentity {
  provider: Provider
  externalId: string
  handle?: string | null
  displayName?: string | null
  email?: string | null
}

export class IdentityResolver {
  /** provider:externalId -> engineerId (or null when known-unmatched) */
  private cache = new Map<string, string | null>()
  /** lowercased email -> engineerId */
  private emailIndex = new Map<string, string>()
  private loaded = false
  private pendingUnmatched = new Map<string, ResolvableIdentity & { count: number }>()

  constructor(private readonly db: SupabaseClient) {}

  private key(provider: string, externalId: string) {
    return `${provider}:${externalId}`
  }

  async load(): Promise<void> {
    if (this.loaded) return

    const { data: identities, error: idError } = await this.db
      .from('engineer_identities')
      .select('engineer_id, provider, external_id')
    if (idError) throw new Error(`Failed to load identities: ${idError.message}`)

    for (const row of identities ?? []) {
      const r = row as { engineer_id: string; provider: string; external_id: string }
      this.cache.set(this.key(r.provider, r.external_id), r.engineer_id)
      if (r.provider === 'email') this.emailIndex.set(r.external_id.toLowerCase(), r.engineer_id)
    }

    const { data: engineers, error: engError } = await this.db
      .from('engineers')
      .select('id, email')
    if (engError) throw new Error(`Failed to load engineers: ${engError.message}`)

    for (const row of engineers ?? []) {
      const r = row as { id: string; email: string | null }
      if (r.email) this.emailIndex.set(r.email.toLowerCase(), r.id)
    }

    this.loaded = true
  }

  /**
   * Resolve an external identity to an engineer id, remembering the mapping so
   * subsequent lookups in the same run are free. Returns null when the person
   * cannot be identified.
   */
  async resolve(identity: ResolvableIdentity): Promise<string | null> {
    await this.load()

    const cacheKey = this.key(identity.provider, identity.externalId)
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      if (cached === null) this.noteUnmatched(identity)
      return cached
    }

    const email = identity.email?.toLowerCase().trim()
    const engineerId = email ? this.emailIndex.get(email) : undefined

    if (engineerId) {
      // Persist the link so future runs skip straight to the cache.
      await this.db.from('engineer_identities').upsert(
        {
          engineer_id: engineerId,
          provider: identity.provider,
          external_id: identity.externalId,
          external_handle: identity.handle ?? identity.displayName ?? null,
        },
        { onConflict: 'provider,external_id' },
      )
      this.cache.set(cacheKey, engineerId)
      return engineerId
    }

    this.cache.set(cacheKey, null)
    this.noteUnmatched(identity)
    return null
  }

  /** Batch the unmatched rows so a backfill does not issue an upsert per event. */
  private noteUnmatched(identity: ResolvableIdentity) {
    const key = this.key(identity.provider, identity.externalId)
    const existing = this.pendingUnmatched.get(key)
    if (existing) {
      existing.count += 1
      return
    }
    this.pendingUnmatched.set(key, { ...identity, count: 1 })
  }

  /**
   * Write the accumulated unmatched identities. Call once at the end of a sync.
   * event_count is incremented rather than overwritten so the admin screen can
   * sort by "how much work are we failing to attribute".
   */
  async flushUnmatched(): Promise<number> {
    if (this.pendingUnmatched.size === 0) return 0

    const rows = Array.from(this.pendingUnmatched.values()).map((i) => ({
      provider: i.provider,
      external_id: i.externalId,
      external_handle: i.handle ?? null,
      display_name: i.displayName ?? null,
      email: i.email ?? null,
      event_count: i.count,
      last_seen_at: new Date().toISOString(),
    }))

    const { error } = await this.db.rpc('upsert_unmatched_identities', { p_rows: rows })
    if (error) throw new Error(`Failed to record unmatched identities: ${error.message}`)

    const count = this.pendingUnmatched.size
    this.pendingUnmatched.clear()
    return count
  }

  /** Invalidate the cache after a manual mapping change. */
  reset() {
    this.cache.clear()
    this.emailIndex.clear()
    this.loaded = false
  }
}
