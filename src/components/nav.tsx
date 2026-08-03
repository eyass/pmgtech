'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

import { PERIODS, type PeriodKey } from '@/lib/queries'

/**
 * Seven entries. Five was the floor, reached by folding three pages into the one
 * they were a view of — squad comparison into the overview it sits below, sprints
 * into the delivery metrics they are part of, and the measurement framework into a
 * reference linked from the pages that cite it instead of a top-level destination.
 * All three routes still resolve, so bookmarks and older links keep working.
 *
 * Two have been added back, and each had to argue for itself against that floor.
 *
 * `/rankings` is the sixth. It is not a view of `/outliers` even though it shares
 * its data: that page explains how the score is built and carries the auditable
 * tables, while this one answers "who is where" in pictures. Folding them together
 * is what made `/outliers` long enough to need splitting in the first place, and the
 * tables stay there deliberately as the reachable-without-hover twin of every chart.
 *
 * `/trust` earns the seventh, for two reasons:
 *
 * - **It is not a view of any one page, so there is nothing to fold it into.** It
 *   is a view of every page — the attribution, freshness and confidence caveats
 *   that qualify the numbers on all five of the others. Putting it under one of
 *   them would imply its answer only applies there.
 * - **A link from the banners cannot carry it, because the banners hide when they
 *   are clean.** The attribution banner disappears above 95%, the sync banner
 *   disappears with no alerts. So on a good day there would be no route to the one
 *   page that can say "today is a day you can quote these" — which is half of what
 *   it is for. A page you need to reach *before* reading a number cannot be
 *   reachable only from the warning that the number is wrong.
 *
 * The framework page is the near miss worth naming: it was demoted for being a
 * reference, and this is not one. Its answer changes every day with the data, and
 * it changes what a reader is allowed to say out loud.
 */
const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/delivery', label: 'Delivery' },
  { href: '/people', label: 'People' },
  { href: '/rankings', label: 'Rankings' },
  { href: '/outliers', label: 'Outliers' },
  { href: '/trust', label: 'Trust' },
  { href: '/admin', label: 'Admin' },
]

export function NavLinks() {
  const pathname = usePathname()

  return (
    <nav className="flex flex-wrap items-center gap-1">
      {LINKS.map((link) => {
        const active =
          link.href === '/' ? pathname === '/' : pathname.startsWith(link.href)
        return (
          <Link
            key={link.href}
            href={link.href}
            // The active link is styled, but styling is not a signal a screen reader
            // gets. aria-current="page" is what tells one which of the seven is where
            // the reader currently is.
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              active
                ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                : 'text-[var(--color-muted)] hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]'
            }`}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * Period picker. Writes the selection to the query string so the choice is
 * shareable and survives a reload, and so server components can read it.
 */
export function PeriodPicker() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const current = (searchParams.get('period') ?? '90d') as PeriodKey

  /**
   * Changing the period re-runs every query on the page, which on the overview is
   * eight aggregates over ninety days. Before this was wrapped in a transition the
   * click had no visible effect at all: the button did not move, because the
   * selection is derived from the URL and the URL had not changed yet, and the page
   * sat there looking unclicked for the whole round trip. The reliable way to
   * discover you had pressed it was pressing it again.
   *
   * `startTransition` gives that wait somewhere to show. The buttons dim and stop
   * accepting input, so a second press cannot queue a second navigation.
   */
  function select(period: string) {
    if (period === current) return
    const params = new URLSearchParams(searchParams.toString())
    params.set('period', period)
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`)
    })
  }

  return (
    <div
      className={`flex items-center gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-0.5 transition-opacity ${
        isPending ? 'opacity-60' : ''
      }`}
      aria-busy={isPending}
    >
      {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => select(key)}
          disabled={isPending}
          aria-pressed={current === key}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            isPending ? 'cursor-wait' : ''
          } ${
            current === key
              ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
              : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
          }`}
        >
          {PERIODS[key].short}
        </button>
      ))}
      {/* Announced rather than drawn: the dimming is invisible to a screen reader. */}
      <span className="sr-only" role="status">
        {isPending ? 'Loading new period' : ''}
      </span>
    </div>
  )
}
