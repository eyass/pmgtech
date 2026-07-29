import { redirect } from 'next/navigation'

import { GoogleSignInButton } from '@/components/sign-in'
import { Card } from '@/components/ui'
import { appEnv } from '@/lib/env'
import { currentUser } from '@/lib/auth'

export const metadata = { title: 'Sign in — PMG Engineering Tracker' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>
}) {
  const { error, next } = await searchParams
  const user = await currentUser()
  if (user) redirect(next && next.startsWith('/') ? next : '/')

  const domain = appEnv().allowedEmailDomain

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center">
      <Card>
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-ink)] text-xs font-bold text-[var(--color-surface)]">
            PMG
          </span>
          <h1 className="text-lg font-semibold">Engineering Tracker</h1>
        </div>

        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Delivery health across Team Buyer, Seller, Monetization and Growth, built from GitLab,
          Jira and HiBob.
        </p>

        {error === 'domain' ? (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            That account is not on the <strong>{domain}</strong> domain, so it cannot access this
            dashboard.
          </p>
        ) : null}

        {error === 'callback' ? (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            Sign-in could not be completed. Please try again.
          </p>
        ) : null}

        <div className="mt-6">
          <GoogleSignInButton next={next} />
        </div>

        <p className="mt-4 text-xs text-[var(--color-muted)]">
          Access is restricted to <strong>@{domain}</strong> Google accounts.
        </p>
      </Card>
    </div>
  )
}
