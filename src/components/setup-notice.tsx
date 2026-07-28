import Link from 'next/link'

import { Card } from '@/components/ui'

/**
 * Shown until a sync has landed data. A dashboard that renders four empty
 * squads with no explanation looks broken; this says exactly what is missing.
 */
export function SetupNotice({
  integrations,
  freshness,
}: {
  integrations: Record<string, { configured: boolean; missing: string[] }>
  freshness: { engineers: number; mergeRequests: number; issues: number }
}) {
  const unconfigured = Object.entries(integrations).filter(([, v]) => !v.configured)

  return (
    <Card className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
      <h2 className="text-sm font-semibold">Finish connecting your sources</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        The schema is live but no data has arrived yet. Everything below will populate once a sync
        runs.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Engineers" value={freshness.engineers} source="HiBob" />
        <Stat label="Merge requests" value={freshness.mergeRequests} source="GitLab" />
        <Stat label="Jira issues" value={freshness.issues} source="Jira" />
      </div>

      {unconfigured.length > 0 ? (
        <div className="mt-4 space-y-2">
          {unconfigured.map(([name, value]) => (
            <div key={name} className="text-sm">
              <span className="font-medium capitalize">{name}</span>
              <span className="text-[var(--color-muted)]"> — set </span>
              <code className="rounded bg-[var(--color-line)] px-1 py-0.5 text-xs">
                {value.missing.join(', ')}
              </code>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm">
          All three integrations are configured. Run the first sync from the{' '}
          <Link href="/admin" className="underline">
            admin page
          </Link>
          .
        </p>
      )}
    </Card>
  )
}

function Stat({ label, value, source }: { label: string; value: number; source: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
      <div className="text-xs text-[var(--color-muted)]">
        {label} <span className="opacity-70">· {source}</span>
      </div>
      <div className="tnum text-lg font-semibold">{value.toLocaleString('en-GB')}</div>
    </div>
  )
}
