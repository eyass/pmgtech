import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

type CookiesToSet = { name: string; value: string; options?: CookieOptions }[]

/**
 * Refreshes the Supabase session cookie and gates the app.
 *
 * Two things must stay true here:
 *  - The cron paths are excluded, because Vercel Cron authenticates with a bearer
 *    token and has no session cookie.
 *  - The domain check happens here as well as in the pages, so an unauthorised
 *    account cannot reach a route handler by guessing its URL.
 *
 * **Excluded from the session gate is not the same as open.** Every path in this
 * list authorises for itself: `/api/sync` and `/api/snapshots` both call
 * `authoriseSync` as their first statement and answer 401 to an anonymous caller,
 * 403 to a signed-in non-admin, and 503 when `CRON_SECRET` is unset. What the
 * exclusion removes is the *redirect*, which is the thing a cron cannot survive —
 * a bearer-token request that gets 307'd to /login is answered 200 by the login
 * page, so the scheduler records a success and the job silently never runs. That
 * is exactly how the score capture was lost the first time: it is easy to add a
 * route and a cron entry, notice nothing, and find out weeks later that there is
 * no history. Any new cron target has to be added here as well.
 */

const PUBLIC_PATHS = ['/login', '/auth/callback', '/auth/signout', '/api/sync', '/api/snapshots']

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next()
  }

  if (process.env.DISABLE_AUTH === 'true') {
    return NextResponse.next()
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: CookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // getUser (not getSession) so the token is actually validated server-side.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const allowedDomain = (process.env.ALLOWED_EMAIL_DOMAIN ?? 'petmediagroup.com').toLowerCase()
  const emailAllowed =
    Boolean(user?.email) && (!allowedDomain || user!.email!.toLowerCase().endsWith(`@${allowedDomain}`))

  if (!user || !emailAllowed) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search = ''
    if (user && !emailAllowed) loginUrl.searchParams.set('error', 'domain')
    // Preserve where they were heading so sign-in can return them there.
    if (pathname !== '/') loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
