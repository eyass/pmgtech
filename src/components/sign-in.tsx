'use client'

import { createBrowserClient } from '@supabase/ssr'
import { useState } from 'react'

/**
 * Google OAuth kick-off. Runs in the browser because the PKCE flow needs to
 * store its verifier client-side before the redirect.
 *
 * hd is passed as a query hint so Google pre-filters to the work domain; the
 * real enforcement is server-side in middleware, since a hint can be removed.
 */
export function GoogleSignInButton({ next }: { next?: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setPending(true)
    setError(null)

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )

    const redirectTo = new URL('/auth/callback', window.location.origin)
    if (next && next.startsWith('/')) redirectTo.searchParams.set('next', next)

    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo.toString(),
        queryParams: {
          hd: process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN ?? 'petmediagroup.com',
          prompt: 'select_account',
        },
      },
    })

    if (signInError) {
      setError(signInError.message)
      setPending(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--color-line)] disabled:opacity-60"
      >
        <GoogleMark />
        {pending ? 'Redirecting to Google…' : 'Continue with Google'}
      </button>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  )
}

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  )
}
