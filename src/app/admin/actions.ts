'use server'

import { revalidatePath } from 'next/cache'

import { currentUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Admin mutations. Every action re-checks admin status server-side — the UI
 * hiding a button is a convenience, not a control.
 */

async function requireAdmin() {
  const user = await currentUser()
  if (!user) throw new Error('Not signed in')
  if (!user.isAdmin) throw new Error('Admin access required')
  return user
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string }

function fail(error: unknown): ActionResult {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

/** Assign an engineer to a squad by hand. Marks the source manual so HiBob will not overwrite it. */
export async function setEngineerSquad(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const engineerId = String(formData.get('engineerId') ?? '')
    const squadId = String(formData.get('squadId') ?? '')
    if (!engineerId) throw new Error('Missing engineer')

    const { error } = await supabaseAdmin()
      .from('engineers')
      .update({
        squad_id: squadId === '' ? null : squadId,
        squad_source: squadId === '' ? 'unassigned' : 'manual',
      })
      .eq('id', engineerId)
    if (error) throw new Error(error.message)

    revalidatePath('/admin')
    revalidatePath('/people')
    revalidatePath('/')
    return { ok: true, message: 'Squad updated' }
  } catch (error) {
    return fail(error)
  }
}

/** Override the seniority derived from the HiBob job title. */
export async function setEngineerSeniority(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const engineerId = String(formData.get('engineerId') ?? '')
    const seniorityKey = String(formData.get('seniorityKey') ?? '')
    if (!engineerId || !seniorityKey) throw new Error('Missing engineer or level')

    const { error } = await supabaseAdmin()
      .from('engineers')
      .update({ seniority_key: seniorityKey, seniority_source: 'manual' })
      .eq('id', engineerId)
    if (error) throw new Error(error.message)

    revalidatePath('/admin')
    revalidatePath('/people')
    return { ok: true, message: 'Level updated' }
  } catch (error) {
    return fail(error)
  }
}

/** Include or exclude someone from delivery metrics without deleting them. */
export async function toggleEngineerMetrics(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const engineerId = String(formData.get('engineerId') ?? '')
    const include = String(formData.get('include') ?? '') === 'true'

    const { error } = await supabaseAdmin()
      .from('engineers')
      // Recorded as a manual choice so the HiBob sync's title-based default (managers and
      // leadership out of per-engineer rates) never overwrites it on a later run.
      .update({ include_in_metrics: include, include_in_metrics_source: 'manual' })
      .eq('id', engineerId)
    if (error) throw new Error(error.message)

    revalidatePath('/admin')
    revalidatePath('/people')
    return { ok: true, message: include ? 'Included in metrics' : 'Excluded from metrics' }
  } catch (error) {
    return fail(error)
  }
}

/** Point a GitLab repository at the squad that owns it. */
export async function setProjectSquad(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const projectId = String(formData.get('projectId') ?? '')
    const squadId = String(formData.get('squadId') ?? '')

    const { error } = await supabaseAdmin()
      .from('gitlab_projects')
      .update({ squad_id: squadId === '' ? null : squadId })
      .eq('id', projectId)
    if (error) throw new Error(error.message)

    revalidatePath('/admin')
    revalidatePath('/')
    return { ok: true, message: 'Repository mapped' }
  } catch (error) {
    return fail(error)
  }
}

export async function toggleProjectTracked(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const projectId = String(formData.get('projectId') ?? '')
    const tracked = String(formData.get('tracked') ?? '') === 'true'

    const { error } = await supabaseAdmin()
      .from('gitlab_projects')
      .update({ is_tracked: tracked })
      .eq('id', projectId)
    if (error) throw new Error(error.message)

    revalidatePath('/admin')
    return { ok: true, message: tracked ? 'Now syncing' : 'Excluded from sync' }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Map a Jira board to a squad. Sprints already synced from that board are
 * updated too, so sprint metrics appear without waiting for the next sync.
 */
export async function setBoardSquad(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const boardId = String(formData.get('boardId') ?? '')
    const squadId = String(formData.get('squadId') ?? '')
    const db = supabaseAdmin()

    const { error } = await db
      .from('jira_boards')
      .update({ squad_id: squadId === '' ? null : squadId })
      .eq('id', boardId)
    if (error) throw new Error(error.message)

    const { error: sprintError } = await db
      .from('jira_sprints')
      .update({ squad_id: squadId === '' ? null : squadId })
      .eq('board_id', boardId)
    if (sprintError) throw new Error(sprintError.message)

    revalidatePath('/admin')
    revalidatePath('/sprints')
    revalidatePath('/')
    return { ok: true, message: 'Board and its sprints mapped' }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Attach an unmatched GitLab/Jira identity to an engineer, then re-attribute the
 * historical rows that were previously anonymous.
 */
export async function linkIdentity(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const identityId = String(formData.get('identityId') ?? '')
    const engineerId = String(formData.get('engineerId') ?? '')
    if (!identityId || !engineerId) throw new Error('Pick an engineer to link to')

    const db = supabaseAdmin()
    const { data: identity, error: loadError } = await db
      .from('unmatched_identities')
      .select('provider, external_id, external_handle, display_name')
      .eq('id', identityId)
      .single()
    if (loadError) throw new Error(loadError.message)

    const row = identity as {
      provider: string
      external_id: string
      external_handle: string | null
      display_name: string | null
    }

    // A commit-email identity is stored as "email:someone@example.com"; unwrap it
    // so it lands under the email provider where re-attribution looks for it.
    const isEmailIdentity = row.external_id.startsWith('email:')
    const provider = isEmailIdentity ? 'email' : row.provider
    const externalId = isEmailIdentity ? row.external_id.slice('email:'.length) : row.external_id

    const { error: insertError } = await db.from('engineer_identities').upsert(
      {
        engineer_id: engineerId,
        provider,
        external_id: externalId,
        external_handle: row.external_handle ?? row.display_name,
      },
      { onConflict: 'provider,external_id' },
    )
    if (insertError) throw new Error(insertError.message)

    // Keep the original key too, so the sync's cache hits on the next run.
    if (isEmailIdentity) {
      await db.from('engineer_identities').upsert(
        {
          engineer_id: engineerId,
          provider: row.provider,
          external_id: row.external_id,
          external_handle: row.external_handle ?? row.display_name,
        },
        { onConflict: 'provider,external_id' },
      )
    }

    const { data: stats, error: rpcError } = await db.rpc('reattribute_from_identities')
    if (rpcError) throw new Error(rpcError.message)

    await db.from('unmatched_identities').delete().eq('id', identityId)

    revalidatePath('/admin')
    revalidatePath('/people')
    revalidatePath('/')

    const counts = (stats ?? {}) as Record<string, number>
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)
    return { ok: true, message: `Linked and re-attributed ${total} historical rows` }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Create an engineer who is not in HiBob — someone who has left but whose git
 * history is still in the window, or a contractor who was never in the HR system.
 *
 * hibob_id stays null, which is what keeps them safe: the HiBob sync only
 * deactivates rows that carry one, so a manual engineer is never marked a leaver
 * by a sync that has never heard of them. Sources are recorded as 'manual' so a
 * later sync does not overwrite the level or squad set here.
 */
export async function createEngineer(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()

    const fullName = String(formData.get('fullName') ?? '').trim()
    if (!fullName) throw new Error('Name is required')

    const rawEmail = String(formData.get('email') ?? '').trim().toLowerCase()
    const email = rawEmail.length > 0 ? rawEmail : null
    const jobTitle = String(formData.get('jobTitle') ?? '').trim() || null
    const seniorityKey = String(formData.get('seniorityKey') ?? '').trim() || 'unknown'
    const squadId = String(formData.get('squadId') ?? '').trim()
    const isActive = String(formData.get('isActive') ?? '') === 'true'

    const db = supabaseAdmin()

    // Email is unique, and a duplicate would otherwise surface as a raw Postgres
    // constraint error. It is also the likeliest mistake: adding someone who is
    // already in the directory under a different spelling of their name.
    if (email) {
      const { data: clash } = await db
        .from('engineers')
        .select('full_name')
        .eq('email', email)
        .maybeSingle()
      if (clash) {
        throw new Error(
          `${email} already belongs to ${(clash as { full_name: string }).full_name}`,
        )
      }
    }

    const { data, error } = await db
      .from('engineers')
      .insert({
        full_name: fullName,
        email,
        job_title: jobTitle,
        seniority_key: seniorityKey,
        seniority_source: seniorityKey === 'unknown' ? 'unknown' : 'manual',
        squad_id: squadId === '' ? null : squadId,
        squad_source: squadId === '' ? 'unassigned' : 'manual',
        is_active: isActive,
        include_in_metrics: true,
        notes: 'Added by hand — not present in HiBob',
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)

    // If an email was given, register it as an identity straight away: commit
    // author emails match on it, so their history attributes without any linking.
    if (email && data) {
      await db.from('engineer_identities').upsert(
        {
          engineer_id: (data as { id: string }).id,
          provider: 'email',
          external_id: email,
          external_handle: email,
        },
        { onConflict: 'provider,external_id' },
      )
      const { data: stats } = await db.rpc('reattribute_from_identities')
      const counts = (stats ?? {}) as Record<string, number>
      const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)

      revalidatePath('/admin')
      revalidatePath('/people')
      revalidatePath('/')
      return {
        ok: true,
        message: `Added ${fullName} and re-attributed ${total} historical rows`,
      }
    }

    revalidatePath('/admin')
    revalidatePath('/people')
    return {
      ok: true,
      message: `Added ${fullName}. Link a GitLab identity to attribute their history.`,
    }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Mark a directory entry as automation rather than a person.
 *
 * A bot can end up in the engineer list the same way anyone does — its commit
 * email matched, or it was added by hand — and once there it distorts two things
 * at once: it counts as a reviewer, and it counts as a head in its squad. So this
 * excludes every provider account linked to it from review analysis, takes it out
 * of metrics, and marks it inactive so it leaves the within-level cohorts. The row
 * is kept rather than deleted, because its identities are what stop the sync
 * re-creating it on the next run.
 */
export async function markEngineerAsBot(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const engineerId = String(formData.get('engineerId') ?? '')
    if (!engineerId) throw new Error('Missing engineer')

    const db = supabaseAdmin()
    const { data: engineer, error: loadError } = await db
      .from('engineers')
      .select('full_name, email')
      .eq('id', engineerId)
      .single()
    if (loadError) throw new Error(loadError.message)
    const engineerRow = engineer as { full_name: string; email: string | null }

    const { data: identities, error: identityError } = await db
      .from('engineer_identities')
      .select('provider, external_id, external_handle')
      .eq('engineer_id', engineerId)
    if (identityError) throw new Error(identityError.message)

    const accounts = (identities ?? [])
      .map((r) => r as { provider: string; external_id: string; external_handle: string | null })
      .filter((r) => r.provider === 'gitlab' || r.provider === 'jira')
      .map((r) => ({ provider: r.provider, external_id: r.external_id, handle: r.external_handle }))

    // The commit address goes in too, so its commits stop counting as well as its
    // reviews. Excluding only the GitLab account left a build bot's commits landing
    // on throughput — half a fix, and the confusing half.
    if (engineerRow.email) {
      accounts.push({
        provider: 'email',
        external_id: engineerRow.email.toLowerCase(),
        handle: engineerRow.email,
      })
    }

    if (accounts.length > 0) {
      const { error: insertError } = await db.from('excluded_accounts').upsert(
        accounts.map((account) => ({
          provider: account.provider,
          external_id: account.external_id,
          label: account.handle ?? engineerRow.full_name,
          reason: 'bot',
        })),
        { onConflict: 'provider,external_id' },
      )
      if (insertError) throw new Error(insertError.message)
    }

    const { error: updateError } = await db
      .from('engineers')
      .update({ include_in_metrics: false, is_active: false })
      .eq('id', engineerId)
    if (updateError) throw new Error(updateError.message)

    const { error: rpcError } = await db.rpc('recompute_mr_review_stats', { p_mr_ids: null })
    if (rpcError) throw new Error(rpcError.message)

    revalidatePath('/admin')
    revalidatePath('/people')
    revalidatePath('/')
    revalidatePath('/delivery')
    return {
      ok: true,
      message:
        accounts.length > 0
          ? `${engineerRow.full_name} marked as automation — ${accounts.length} account(s) excluded from review and commit analysis`
          : `${engineerRow.full_name} taken out of metrics. No linked account or email to exclude, so nothing to remove from the analysis.`,
    }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Record an account as automated, so its comments stop counting as reviews.
 *
 * Separate from dismissing: dismissing only hides a row from triage, whereas this
 * changes the analysis. An AI reviewer that comments within seconds of every merge
 * request opening makes "time to first review" measure the bot's latency instead
 * of a colleague's.
 */
export async function markIdentityAsBot(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const identityId = String(formData.get('identityId') ?? '')
    if (!identityId) throw new Error('Missing identity')

    const db = supabaseAdmin()
    const { data: identity, error: loadError } = await db
      .from('unmatched_identities')
      .select('provider, external_id, external_handle, display_name')
      .eq('id', identityId)
      .single()
    if (loadError) throw new Error(loadError.message)

    const row = identity as {
      provider: string
      external_id: string
      external_handle: string | null
      display_name: string | null
    }
    // Commit-email identities are stored as "email:someone@example.com". These used
    // to be refused, on the grounds that excluding one drops commit history rather
    // than a reviewer — but that is exactly right for a service account like ci@ or
    // a build bot that commits under a real address. Recorded under the 'email'
    // provider, which v_commits also honours, so its commits stop counting too.
    const isEmailIdentity = row.external_id.startsWith('email:')
    const provider = isEmailIdentity ? 'email' : row.provider
    const externalId = isEmailIdentity
      ? row.external_id.slice('email:'.length).toLowerCase()
      : row.external_id

    const { error: insertError } = await db.from('excluded_accounts').upsert(
      {
        provider,
        external_id: externalId,
        label: row.display_name ?? row.external_handle,
        reason: isEmailIdentity ? 'service-account' : 'bot',
      },
      { onConflict: 'provider,external_id' },
    )
    if (insertError) throw new Error(insertError.message)

    await db.from('unmatched_identities').update({ dismissed: true }).eq('id', identityId)

    // An address may already be linked to an engineer — a bot that matched a person
    // record, or one added by hand. Take that row out of metrics and cohorts too,
    // otherwise the directory keeps counting it as a head.
    if (isEmailIdentity) {
      await db
        .from('engineers')
        .update({ include_in_metrics: false, is_active: false })
        .eq('email', externalId)
    }

    // Review timing and reviewer counts are stored on merge_requests, so they have
    // to be re-derived for the exclusion to affect history already synced.
    const { error: rpcError } = await db.rpc('recompute_mr_review_stats', { p_mr_ids: null })
    if (rpcError) throw new Error(rpcError.message)

    revalidatePath('/admin')
    revalidatePath('/')
    revalidatePath('/delivery')
    return {
      ok: true,
      message: `${row.display_name ?? row.external_handle} excluded from review analysis`,
    }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Accept a commit-bridge suggestion.
 *
 * Keyed on provider + external id rather than an unmatched_identities row, because a
 * candidate can exist without one: the account may have been dismissed from triage
 * earlier, or first seen through a merge request rather than a review event.
 */
export async function linkBridgeCandidate(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const provider = String(formData.get('provider') ?? 'gitlab')
    const externalId = String(formData.get('externalId') ?? '')
    const engineerId = String(formData.get('engineerId') ?? '')
    const handle = String(formData.get('handle') ?? '') || null
    if (!externalId || !engineerId) throw new Error('Pick an engineer to link to')

    const db = supabaseAdmin()
    const { error: insertError } = await db.from('engineer_identities').upsert(
      { engineer_id: engineerId, provider, external_id: externalId, external_handle: handle },
      { onConflict: 'provider,external_id' },
    )
    if (insertError) throw new Error(insertError.message)

    const { data: stats, error: rpcError } = await db.rpc('reattribute_from_identities')
    if (rpcError) throw new Error(rpcError.message)

    await db
      .from('unmatched_identities')
      .delete()
      .eq('provider', provider)
      .eq('external_id', externalId)

    revalidatePath('/admin')
    revalidatePath('/people')
    revalidatePath('/')

    const counts = (stats ?? {}) as Record<string, number>
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)
    return { ok: true, message: `Linked and re-attributed ${total} historical rows` }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Exclude an account the bridge identified as machinery — its commits are authored by a
 * generated address like `service_account_…@noreply.gitlab.com` that no person owns.
 *
 * Worth doing rather than dismissing: the largest such account here opened 325 merge
 * requests, and while it sits in the unattributed pile it makes org-wide attribution
 * coverage look far worse than it is.
 */
export async function markBridgeCandidateAsBot(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const provider = String(formData.get('provider') ?? 'gitlab')
    const externalId = String(formData.get('externalId') ?? '')
    const label = String(formData.get('label') ?? '') || null
    if (!externalId) throw new Error('Missing identity')

    const db = supabaseAdmin()
    const { error: insertError } = await db
      .from('excluded_accounts')
      .upsert({ provider, external_id: externalId, label, reason: 'bot' }, {
        onConflict: 'provider,external_id',
      })
    if (insertError) throw new Error(insertError.message)

    await db
      .from('unmatched_identities')
      .update({ dismissed: true })
      .eq('provider', provider)
      .eq('external_id', externalId)

    const { error: rpcError } = await db.rpc('recompute_mr_review_stats', { p_mr_ids: null })
    if (rpcError) throw new Error(rpcError.message)

    revalidatePath('/admin')
    revalidatePath('/')
    revalidatePath('/delivery')
    return { ok: true, message: `${label ?? externalId} excluded as a bot` }
  } catch (error) {
    return fail(error)
  }
}

/** Hide an identity that will never map to a person — a bot, a service account. */
export async function dismissIdentity(formData: FormData): Promise<ActionResult> {
  try {
    await requireAdmin()
    const identityId = String(formData.get('identityId') ?? '')
    const { error } = await supabaseAdmin()
      .from('unmatched_identities')
      .update({ dismissed: true })
      .eq('id', identityId)
    if (error) throw new Error(error.message)

    revalidatePath('/admin')
    return { ok: true, message: 'Identity dismissed' }
  } catch (error) {
    return fail(error)
  }
}
