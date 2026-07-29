import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'

import { NavLinks, PeriodPicker } from '@/components/nav'
import { currentUser } from '@/lib/auth'

import './globals.css'

export const metadata: Metadata = {
  title: 'PMG Engineering Tracker',
  description:
    'Delivery health across Team Buyer, Seller, Monetization, Growth and DevExp, from GitLab, Jira and HiBob.',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()

  return (
    <html lang="en-GB">
      <body className="min-h-screen">
        {user ? (
          <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-[var(--color-surface)]/85 backdrop-blur">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
              <Link href="/" className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg bg-[var(--color-ink)] text-xs font-bold text-[var(--color-surface)]">
                  PMG
                </span>
                <span className="text-sm font-semibold">Engineering Tracker</span>
              </Link>

              <NavLinks />

              <div className="ml-auto flex items-center gap-3">
                <Suspense fallback={null}>
                  <PeriodPicker />
                </Suspense>
                <div className="hidden text-right sm:block">
                  <div className="text-xs font-medium">{user.name ?? user.email}</div>
                  <div className="text-[11px] text-[var(--color-muted)]">
                    {user.isAdmin ? 'Admin' : 'Viewer'}
                  </div>
                </div>
                <Link
                  href="/auth/signout"
                  prefetch={false}
                  className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                >
                  Sign out
                </Link>
              </div>
            </div>
          </header>
        ) : null}

        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  )
}
