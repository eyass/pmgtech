import { NextResponse, type NextRequest } from 'next/server'

import { isAllowedEmail } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * OAuth callback. Exchanges the code for a session, then immediately checks the
 * email domain — a Google account outside the org must not end up with a valid
 * session cookie, even a short-lived one.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const next = searchParams.get('next')
  const target = next && next.startsWith('/') ? next : '/'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=callback`)
  }

  const supabase = await supabaseServer()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/login?error=callback`)
  }

  if (!isAllowedEmail(data.user.email)) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=domain`)
  }

  return NextResponse.redirect(`${origin}${target}`)
}
