import Link from 'next/link'

import { Card } from '@/components/ui'
import { nf, pct } from '@/lib/format'
import type { SyncAlert } from '@/lib/queries'
import type { OrgKpis } from '@/lib/types/metrics'

/**
 * Sync problems, stated on the page rather than left in the admin screen.
 *
 * A broken sync does not look broken on a dashboard — it looks like a quiet week. Every
 * number falls together, in a believable direction, and the natural reading is that the
 * team slowed down. So a stale or non-converging source has to say so next to the numbers
 * it is making wrong.
 */
export function SyncAlertBanner({ alerts }: { alerts: SyncAlert[] }) {
  if (alerts.length === 0) return null
  const worst = alerts.some((a) => a.level === 'bad') ? 'bad' : 'warn'

  return (
    <Card
      className={
        worst === 'bad'
          ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
          : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
      }
    >
      <p className="text-xs leading-relaxed">
        <strong>
          {worst === 'bad' ? 'Data may be out of date.' : 'One source is behind.'}
        </strong>{' '}
        A sync that is not running does not make the numbers look wrong — it makes them look
        like a quiet week.
      </p>
      <ul className="mt-2 space-y-0.5 text-xs">
        {alerts.map((alert, i) => (
          <li key={`${alert.source}-${i}`}>
            <span className="font-medium capitalize">{alert.source}</span>: {alert.message}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs">
        <Link href="/admin" className="underline">
          Sync history and manual runs
        </Link>
      </p>
    </Card>
  )
}

/**
 * How much of the collected work is attributed to a person.
 *
 * This exists because every per-person and per-squad number on the site is a slice of
 * this figure and nothing said so. At 54% MR attribution, a squad's "60 merged" is a
 * lower bound, not a total — and the gap is not random, it is whichever GitLab or Jira
 * accounts have not been linked to an engineer yet, which skews systematically towards
 * whoever's accounts are unmapped.
 *
 * Shown wherever a per-person or per-squad total appears, so a total is never read as
 * complete when it isn't.
 */
export function AttributionBanner({
  kpis,
  scope = 'org',
}: {
  kpis: OrgKpis
  /** 'squad' wording where the page shows one squad rather than the whole org. */
  scope?: 'org' | 'squad' | 'people'
}) {
  const mr = kpis.mr_attribution_pct
  const commits = kpis.commit_attribution_pct
  if (mr === null && commits === null) return null

  const worst = Math.min(mr ?? 100, commits ?? 100)
  // Above 95% the gap is small enough to be noise and the banner is just clutter.
  if (worst >= 95) return null

  const tone =
    worst < 70
      ? 'mb-3 border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
      : 'mb-3 border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'

  const subject =
    scope === 'squad'
      ? 'This squad’s totals'
      : scope === 'people'
        ? 'These per-person totals'
        : 'Per-person and per-squad totals'

  return (
    <Card className={tone}>
      <p className="text-xs leading-relaxed">
        <strong>{subject} are a lower bound.</strong> {pct(mr, 1)} of merged merge requests
        and {pct(commits, 1)} of commits in this period resolve to a known engineer.
        {kpis.unattributed_mrs > 0 ? (
          <>
            {' '}
            The other {nf(kpis.unattributed_mrs)} merge{' '}
            {kpis.unattributed_mrs === 1 ? 'request' : 'requests'} count towards the org totals
            but towards nobody’s.
          </>
        ) : null}{' '}
        The gap is unlinked GitLab and Jira accounts rather than a random sample, so it does not
        cancel out between squads.
        {kpis.unmapped_identities > 0 ? (
          <>
            {' '}
            <Link href="/admin" className="underline">
              Link the {nf(kpis.unmapped_identities)} unmapped{' '}
              {kpis.unmapped_identities === 1 ? 'identity' : 'identities'}
            </Link>{' '}
            to close it.
          </>
        ) : null}
      </p>
    </Card>
  )
}
