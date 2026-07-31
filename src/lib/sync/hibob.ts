import { hibobEnv } from '@/lib/env'
import { HiBobClient, squadKeyFromDepartment, type HiBobPerson } from '@/lib/integrations/hibob'
import { isNonIcTitle } from '@/lib/sync/matching'
import { SyncContext, type SyncMode, type SyncTrigger } from '@/lib/sync/runner'

/**
 * HiBob sync. Establishes the engineer directory: who exists, what level they
 * are, which squad they sit in, whether they are still employed.
 *
 * Rules that matter:
 *  - Manual overrides win. If someone set a squad, seniority, metric inclusion or
 *    start date by hand in the admin screen, HiBob does not overwrite it on the
 *    next run. Without that, a correction lasts until the next nightly sync and
 *    reverts silently, which looks exactly like the feature not working.
 *  - Non-engineering departments are skipped so the directory stays the eng org.
 *  - Managers and leadership default out of per-engineer rates (include_in_metrics),
 *    which changes the denominator only — their own work still counts. See 0017.
 *  - Leavers are marked inactive rather than deleted, so their historical
 *    contribution stays attributed in past quarters.
 */
export async function syncHiBob(
  mode: SyncMode = 'incremental',
  trigger: SyncTrigger = 'manual',
) {
  const ctx = new SyncContext('hibob', mode, trigger)
  await ctx.start()

  try {
    const env = hibobEnv()
    const client = new HiBobClient()

    ctx.log('Fetching people from HiBob')
    const everyone = await client.employees()
    ctx.log(`HiBob returned ${everyone.length} people`)

    const engineering = everyone.filter((p) => isEngineering(p, env.engineeringDepartments))
    ctx.log(
      `${engineering.length} in engineering departments (${env.engineeringDepartments.join(', ')})`,
    )

    const squads = await loadSquadIds(ctx)
    const existing = await loadExistingEngineers(ctx)

    let created = 0
    let updated = 0
    let squadAssigned = 0
    const seenHibobIds = new Set<string>()

    for (const person of engineering) {
      seenHibobIds.add(person.hibobId)
      const prior = person.email
        ? existing.byEmail.get(person.email)
        : existing.byHibobId.get(person.hibobId)

      const seniorityKey = await normaliseSeniority(ctx, person.jobTitle)
      const derivedSquadKey = squadKeyFromDepartment(person.department)
      const derivedSquadId = derivedSquadKey ? squads.get(derivedSquadKey) ?? null : null

      // Respect manual overrides set in the admin screen.
      const keepManualSquad = prior?.squad_source === 'manual'
      const keepManualSeniority = prior?.seniority_source === 'manual'
      const keepManualMetrics = prior?.include_in_metrics_source === 'manual'
      const keepManualStartDate = prior?.start_date_source === 'manual'

      const row: Record<string, unknown> = {
        hibob_id: person.hibobId,
        email: person.email,
        full_name: person.fullName,
        avatar_url: person.avatarUrl,
        job_title: person.jobTitle,
        department: person.department,
        site: person.site,
        manager_email: person.managerEmail,
        employment_type: person.employmentType,
        is_active: person.isActive,
      }

      // Start date drives the tenure normalisation in migration 0028 — a wrong or
      // missing one moves the person's score and their whole cohort's median — so a
      // hand-set value is protected the same way squad, level and metric inclusion
      // already are. A manual row with a null date is a deliberate "we do not know"
      // and is protected too, which is why this branches on the source rather than
      // on whether a date is present.
      if (!keepManualStartDate) {
        row.start_date = person.startDate
        // No date from HiBob is not a provenance. Recording 'hibob' for a null would
        // let a later run's real date look like an overwrite of a considered answer.
        row.start_date_source = person.startDate ? 'hibob' : 'unknown'
      }

      if (!keepManualSquad && derivedSquadId) {
        row.squad_id = derivedSquadId
        row.squad_source = 'hibob'
      }
      if (!keepManualSeniority) {
        row.seniority_key = seniorityKey
        row.seniority_source = 'hibob'
      }
      if (!keepManualMetrics) {
        // Managers and leadership stay in the directory but out of per-engineer rates.
        // This only affects the denominator — their merge requests, reviews and commits
        // still count towards their squad. See migration 0017.
        row.include_in_metrics = !isNonIcTitle(person.jobTitle)
        row.include_in_metrics_source = 'auto'
      }

      if (prior) {
        const { error } = await ctx.db.from('engineers').update(row).eq('id', prior.id)
        if (error) throw new Error(`Failed to update ${person.email ?? person.hibobId}: ${error.message}`)
        updated++
        if (!keepManualSquad && derivedSquadId && prior.squad_id !== derivedSquadId) squadAssigned++
      } else {
        const { data, error } = await ctx.db.from('engineers').insert(row).select('id').single()
        if (error) throw new Error(`Failed to insert ${person.email ?? person.hibobId}: ${error.message}`)
        created++
        if (derivedSquadId) squadAssigned++

        // Record the HiBob and email identities so GitLab/Jira can resolve later.
        const engineerId = (data as { id: string }).id
        const identities: Record<string, unknown>[] = [
          {
            engineer_id: engineerId,
            provider: 'hibob',
            external_id: person.hibobId,
            external_handle: person.fullName,
            is_primary: true,
          },
        ]
        if (person.email) {
          identities.push({
            engineer_id: engineerId,
            provider: 'email',
            external_id: person.email,
            external_handle: person.fullName,
            is_primary: true,
          })
        }
        await ctx.db
          .from('engineer_identities')
          .upsert(identities, { onConflict: 'provider,external_id' })
      }
    }

    // Anyone previously synced from HiBob who is no longer in the engineering
    // set has either left or moved out of engineering — mark inactive.
    const goneInactive = await deactivateMissing(ctx, seenHibobIds)

    // Newly created engineers may match GitLab/Jira identities already stored.
    const { data: reattributed } = await ctx.db.rpc('reattribute_from_identities')

    const stats = {
      people_fetched: everyone.length,
      engineering_people: engineering.length,
      engineers_created: created,
      engineers_updated: updated,
      squads_assigned: squadAssigned,
      marked_inactive: goneInactive,
      reattributed: JSON.stringify(reattributed ?? {}),
    }

    await ctx.setCursor('people', new Date().toISOString())
    await ctx.finish('success', stats)
    return stats
  } catch (error) {
    await ctx.finish('error', {}, error)
    throw error
  }
}

function isEngineering(person: HiBobPerson, departments: string[]): boolean {
  if (departments.length === 0) return true
  const dept = (person.department ?? '').toLowerCase()
  if (!dept) return false
  return departments.some((d) => dept.includes(d.toLowerCase()))
}

async function normaliseSeniority(ctx: SyncContext, title: string | null): Promise<string> {
  if (!title) return 'unknown'
  const { data, error } = await ctx.db.rpc('normalise_seniority', { p_title: title })
  if (error) return 'unknown'
  return (data as string | null) ?? 'unknown'
}

async function loadSquadIds(ctx: SyncContext): Promise<Map<string, string>> {
  const { data, error } = await ctx.db.from('squads').select('id, key')
  if (error) throw new Error(`Failed to load squads: ${error.message}`)
  return new Map((data ?? []).map((s) => [(s as { key: string }).key, (s as { id: string }).id]))
}

async function loadExistingEngineers(ctx: SyncContext) {
  const { data, error } = await ctx.db
    .from('engineers')
    .select(
      'id, email, hibob_id, squad_id, squad_source, seniority_source, include_in_metrics_source, start_date_source',
    )
  if (error) throw new Error(`Failed to load engineers: ${error.message}`)

  type Row = {
    id: string
    email: string | null
    hibob_id: string | null
    squad_id: string | null
    squad_source: string
    seniority_source: string
    include_in_metrics_source: string
    start_date_source: string
  }

  const byEmail = new Map<string, Row>()
  const byHibobId = new Map<string, Row>()
  for (const row of (data ?? []) as Row[]) {
    if (row.email) byEmail.set(row.email.toLowerCase(), row)
    if (row.hibob_id) byHibobId.set(row.hibob_id, row)
  }
  return { byEmail, byHibobId }
}

/**
 * Deactivate engineers that HiBob previously reported but no longer returns in
 * the engineering set. Only touches rows that came from HiBob, so people added
 * by hand are left alone.
 */
async function deactivateMissing(ctx: SyncContext, seenHibobIds: Set<string>): Promise<number> {
  const { data, error } = await ctx.db
    .from('engineers')
    .select('id, hibob_id')
    .not('hibob_id', 'is', null)
    .eq('is_active', true)
  if (error) throw new Error(`Failed to load engineers for deactivation: ${error.message}`)

  const stale = (data ?? [])
    .map((r) => r as { id: string; hibob_id: string })
    .filter((r) => !seenHibobIds.has(r.hibob_id))
    .map((r) => r.id)

  if (stale.length === 0) return 0

  const { error: updateError } = await ctx.db
    .from('engineers')
    .update({ is_active: false })
    .in('id', stale)
  if (updateError) throw new Error(`Failed to deactivate leavers: ${updateError.message}`)

  ctx.log(`Marked ${stale.length} engineers inactive (no longer in HiBob engineering)`)
  return stale.length
}
