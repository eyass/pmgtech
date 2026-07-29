import { appEnv } from '@/lib/env'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { supabaseServer } from '@/lib/supabase/server'

export interface SessionUser {
  email: string
  name: string | null
  avatarUrl: string | null
  isAdmin: boolean
}

/** Domain gate. The Google provider itself does not restrict by domain. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const domain = appEnv().allowedEmailDomain.toLowerCase()
  if (!domain) return true
  return email.toLowerCase().endsWith(`@${domain}`)
}

/**
 * Admins can run syncs and change squad/board mappings. The list lives in the
 * app_admins table; if it is empty, every allowed-domain user is treated as an
 * admin so the app is usable immediately after deploy.
 */
export async function isAdminEmail(email: string): Promise<boolean> {
  const db = supabaseAdmin()
  const { count } = await db.from('app_admins').select('email', { count: 'exact', head: true })
  if (!count || count === 0) return isAllowedEmail(email)

  const { data } = await db
    .from('app_admins')
    .select('email')
    .eq('email', email.toLowerCase())
    .maybeSingle()
  return Boolean(data)
}

/**
 * The signed-in user, or null. Returns a synthetic local user when DISABLE_AUTH
 * is set, which is only intended for local development.
 */
export async function currentUser(): Promise<SessionUser | null> {
  if (appEnv().disableAuth) {
    return { email: 'local@localhost', name: 'Local Dev', avatarUrl: null, isAdmin: true }
  }

  const supabase = await supabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.email || !isAllowedEmail(user.email)) return null

  return {
    email: user.email,
    name:
      (user.user_metadata?.full_name as string | undefined) ??
      (user.user_metadata?.name as string | undefined) ??
      null,
    avatarUrl: (user.user_metadata?.avatar_url as string | undefined) ?? null,
    isAdmin: await isAdminEmail(user.email),
  }
}
