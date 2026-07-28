'use server'

import { revalidatePath } from 'next/cache'

import { currentUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Assessment writes. Personnel data, so admin status is re-checked server-side
 * and the assessor's identity is taken from the session rather than the form —
 * a submitted `assessed_by` could otherwise be forged.
 */

export type SaveResult = { ok: true; message: string } | { ok: false; message: string }

async function requireAdmin() {
  const user = await currentUser()
  if (!user) throw new Error('Not signed in')
  if (!user.isAdmin) throw new Error('Recording an assessment requires admin access')
  return user
}

const DIMENSIONS = ['flow', 'quality', 'collaboration', 'impact'] as const

export async function saveAssessment(formData: FormData): Promise<SaveResult> {
  try {
    const user = await requireAdmin()
    const engineerId = String(formData.get('engineerId') ?? '')
    const periodStart = String(formData.get('periodStart') ?? '')
    const periodEnd = String(formData.get('periodEnd') ?? '')
    if (!engineerId || !periodStart || !periodEnd) throw new Error('Missing engineer or period')

    const db = supabaseAdmin()
    const rows: Record<string, unknown>[] = []

    for (const dimension of DIMENSIONS) {
      const ratingRaw = String(formData.get(`rating_${dimension}`) ?? '')
      const evidence = String(formData.get(`evidence_${dimension}`) ?? '').trim()
      const rating = ratingRaw === '' ? null : Number(ratingRaw)

      if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
        throw new Error(`Rating for ${dimension} must be between 1 and 5`)
      }
      // A rating with no evidence is the thing this form exists to prevent.
      if (rating !== null && evidence.length === 0) {
        throw new Error(`Add evidence for ${dimension} — a rating on its own is not reviewable`)
      }
      if (rating === null && evidence.length === 0) continue

      rows.push({
        engineer_id: engineerId,
        period_start: periodStart,
        period_end: periodEnd,
        dimension_key: dimension,
        rating,
        evidence: evidence.length > 0 ? evidence : null,
        assessed_by: user.email,
      })
    }

    if (rows.length > 0) {
      const { error } = await db
        .from('engineer_assessments')
        .upsert(rows, { onConflict: 'engineer_id,period_start,period_end,dimension_key' })
      if (error) throw new Error(error.message)
    }

    const headline = String(formData.get('headline') ?? '').trim()
    const strengths = String(formData.get('strengths') ?? '').trim()
    const growth = String(formData.get('growth') ?? '').trim()

    if (headline || strengths || growth) {
      const { error } = await db.from('assessment_summaries').upsert(
        {
          engineer_id: engineerId,
          period_start: periodStart,
          period_end: periodEnd,
          headline: headline || null,
          strengths: strengths || null,
          growth: growth || null,
          assessed_by: user.email,
        },
        { onConflict: 'engineer_id,period_start,period_end' },
      )
      if (error) throw new Error(error.message)
    }

    revalidatePath(`/people/${engineerId}`)
    return {
      ok: true,
      message:
        rows.length > 0
          ? `Saved ${rows.length} ${rows.length === 1 ? 'dimension' : 'dimensions'}`
          : 'Saved summary',
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
