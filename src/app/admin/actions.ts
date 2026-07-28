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
      .update({ include_in_metrics: include })
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
