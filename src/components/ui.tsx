import Link from 'next/link'
import type { ReactNode } from 'react'

import { squadColour, toneFor, type MetricDirection } from '@/lib/format'

const TONE_CLASS = {
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
  neutral: 'text-[var(--color-ink)]',
} as const

export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 ${className}`}
    >
      {children}
    </div>
  )
}

export function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-[var(--color-muted)]">{hint}</p> : null}
      </div>
      {action}
    </div>
  )
}

/**
 * A single headline number. `hint` is used heavily to state the definition of
 * the metric inline — a dashboard whose numbers are not defined gets argued
 * with rather than acted on.
 */
export function Kpi({
  label,
  value,
  hint,
  direction = 'neutral',
  raw,
  thresholds,
}: {
  label: string
  value: string
  hint?: string
  direction?: MetricDirection
  raw?: number | null
  thresholds?: { good: number; bad: number }
}) {
  const tone = toneFor(direction, raw, thresholds)
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {label}
      </span>
      <span className={`tnum text-2xl font-semibold ${TONE_CLASS[tone]}`}>{value}</span>
      {hint ? <span className="text-xs text-[var(--color-muted)]">{hint}</span> : null}
    </Card>
  )
}

export function SquadBadge({
  squadKey,
  name,
  href,
}: {
  squadKey: string | null
  name: string | null
  href?: string
}) {
  const label = name ?? 'Unassigned'
  const content = (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ backgroundColor: squadColour(squadKey) }}
      />
      {label}
    </span>
  )
  return href ? (
    <Link href={href} className="hover:underline">
      {content}
    </Link>
  ) : (
    content
  )
}

export function Table({
  head,
  children,
  empty,
}: {
  head: ReactNode
  children: ReactNode
  empty?: string
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children)
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
            {head}
          </tr>
        </thead>
        <tbody>
          {hasRows ? (
            children
          ) : (
            <tr>
              <td colSpan={99} className="p-6 text-center text-sm text-[var(--color-muted)]">
                {empty ?? 'Nothing to show yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export function Th({
  children,
  align = 'left',
  title,
}: {
  children: ReactNode
  align?: 'left' | 'right'
  title?: string
}) {
  return (
    <th
      scope="col"
      title={title}
      className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align = 'left',
  numeric = false,
  className = '',
}: {
  children: ReactNode
  align?: 'left' | 'right'
  numeric?: boolean
  className?: string
}) {
  return (
    <td
      className={`border-b border-[var(--color-line)] px-3 py-2 ${
        align === 'right' ? 'text-right' : ''
      } ${numeric ? 'tnum' : ''} ${className}`}
    >
      {children}
    </td>
  )
}

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  const classes = {
    neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    bad: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  }[tone]
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {children}
    </span>
  )
}

/**
 * Horizontal bar used inside table cells for at-a-glance comparison. Cheaper and
 * more legible than a chart when the column already shows the number.
 */
export function Bar({
  value,
  max,
  colour,
}: {
  value: number
  max: number
  colour?: string
}) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line)]">
      <div
        className="h-full rounded-full"
        style={{ width: `${width}%`, backgroundColor: colour ?? 'var(--color-muted)' }}
      />
    </div>
  )
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <Card className="text-center">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mx-auto mt-1 max-w-prose text-sm text-[var(--color-muted)]">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </Card>
  )
}

export function MetricNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 text-xs leading-relaxed text-[var(--color-muted)]">{children}</p>
  )
}
