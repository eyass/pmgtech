'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { PERIODS, type PeriodKey } from '@/lib/queries'

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/squads', label: 'Squads' },
  { href: '/delivery', label: 'Delivery' },
  { href: '/sprints', label: 'Sprints' },
  { href: '/people', label: 'People' },
  { href: '/performance', label: 'Framework' },
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
  const current = (searchParams.get('period') ?? '90d') as PeriodKey

  function select(period: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('period', period)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-0.5">
      {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => select(key)}
          aria-pressed={current === key}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            current === key
              ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
              : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
          }`}
        >
          {PERIODS[key].short}
        </button>
      ))}
    </div>
  )
}
