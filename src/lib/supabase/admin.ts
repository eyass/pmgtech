import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { supabaseEnv } from '@/lib/env'

let cached: SupabaseClient | null = null

/**
 * Service-role client. Bypasses RLS, so it must only ever be constructed in
 * server-only code paths (server components, route handlers, server actions).
 * Every dashboard read and every sync write goes through this.
 *
 * The client is deliberately untyped at the table level; the shapes that matter
 * — the aggregation RPC results the UI renders — are typed explicitly in
 * lib/types/metrics.ts. Run `npx supabase gen types typescript` and pass the
 * generated `Database` type here if you want table-level inference too.
 */
export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached
  cached = createClient(supabaseEnv.url, supabaseEnv.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'pmgtech' } },
  })
  return cached
}
