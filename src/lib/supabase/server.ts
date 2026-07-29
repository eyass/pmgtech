import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { supabaseEnv } from '@/lib/env'

type CookiesToSet = { name: string; value: string; options?: CookieOptions }[]

/**
 * Cookie-backed client used purely for reading the signed-in user's session.
 * Data reads use the service-role client instead — see lib/supabase/admin.ts.
 */
export async function supabaseServer() {
  const cookieStore = await cookies()

  return createServerClient(supabaseEnv.url, supabaseEnv.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: CookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a server component, where cookies are read-only. The
          // middleware refresh path is what actually persists rotated tokens.
        }
      },
    },
  })
}
