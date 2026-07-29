/** Presentation helpers. Kept separate so metric formatting is consistent. */

export function nf(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '—'
  return `${nf(value, digits)}%`
}

/**
 * Durations are stored in hours. Below a day people think in hours; above it,
 * days are far easier to reason about.
 */
export function hours(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1) return `${Math.round(value * 60)}m`
  if (value < 48) return `${nf(value, 1)}h`
  return `${nf(value / 24, 1)}d`
}

export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (Math.abs(value) >= 1_000_000) return `${nf(value / 1_000_000, 1)}M`
  if (Math.abs(value) >= 1_000) return `${nf(value / 1_000, 1)}k`
  return nf(value)
}

export function relativeDate(value: string | null | undefined): string {
  if (!value) return 'never'
  const then = new Date(value).getTime()
  const diffMs = Date.now() - then
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const h = Math.round(minutes / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 31) return `${d}d ago`
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function bucketLabel(value: string, bucket: 'day' | 'week' | 'month'): string {
  const date = new Date(value)
  if (bucket === 'month') {
    return date.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// Keyed to match the colour column on squads, so a badge and a chart series
// agree. A squad missing from here falls back to grey rather than breaking.
export const SQUAD_COLOURS: Record<string, string> = {
  buyer: '#2563eb',
  seller: '#059669',
  monetization: '#d97706',
  growth: '#7c3aed',
  devexp: '#0891b2',
  product: '#db2777',
  data: '#65a30d',
  security: '#dc2626',
}

export function squadColour(key: string | null | undefined): string {
  return (key && SQUAD_COLOURS[key]) || '#64748b'
}

/**
 * Direction a metric should move in, so the UI can colour a delta without every
 * caller re-deciding whether "up" is good.
 */
export type MetricDirection = 'higher-better' | 'lower-better' | 'neutral'

export function toneFor(
  direction: MetricDirection,
  value: number | null | undefined,
  thresholds?: { good: number; bad: number },
): 'good' | 'warn' | 'bad' | 'neutral' {
  if (value === null || value === undefined || !thresholds) return 'neutral'
  if (direction === 'higher-better') {
    if (value >= thresholds.good) return 'good'
    if (value <= thresholds.bad) return 'bad'
    return 'warn'
  }
  if (direction === 'lower-better') {
    if (value <= thresholds.good) return 'good'
    if (value >= thresholds.bad) return 'bad'
    return 'warn'
  }
  return 'neutral'
}
