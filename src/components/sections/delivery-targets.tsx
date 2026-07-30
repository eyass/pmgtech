import Link from 'next/link'

import { MetricTargetForm } from '@/components/admin-forms'
import { Card, MetricNote, Pill, SectionHeading, Table, Td, Th } from '@/components/ui'
import { nf, relativeDate } from '@/lib/format'
import {
  orderedTargets,
  SEVERITY_MEANING,
  type ChangeSeverity,
  type MetricTargetResolution,
  type ResolvedTarget,
  type TargetChange,
} from '@/lib/targets'

/**
 * The delivery-targets admin section: thirteen editable thresholds and the trail of
 * who moved them.
 *
 * A section component rather than JSX inside `/admin/page.tsx` for the reason the
 * other files in this folder exist — the page is long, and a block this dense is
 * easier to reason about, and to look at in isolation, when it is its own file.
 *
 * The thing this section is designed around: a squad score falling has two possible
 * causes, the squad and the yardstick, and a number on its own cannot tell you
 * which. So the history table is not an afterthought below the form. It states the
 * before and after, whether the change made the target harder or easier, and what
 * the move did to a squad that did not change at all — that last column is the one
 * that makes the trail an explanation instead of a log.
 */
export function DeliveryTargetsSection({
  targetSet,
  history,
  readOnly,
  action,
}: {
  targetSet: MetricTargetResolution
  history: { changes: TargetChange[]; error: string | null }
  readOnly: boolean
  action: (formData: FormData) => Promise<{ ok: boolean; message: string }>
}) {
  const targets = orderedTargets(targetSet.targets)
  const scored = targets.filter((t) => t.dimension !== null)
  const colourOnly = targets.filter((t) => t.dimension === null)

  return (
    <section id="targets">
      <SectionHeading
        title="Delivery targets"
        hint="The absolute thresholds every squad metric is scored and coloured against — the only place in the app where a number is judged against a fixed value, and squads only, never people. Seeded in migration 0027 from the values that used to be hardcoded, so nothing moved when they became editable."
      />

      {targetSet.problems.length > 0 ? (
        <Card className="mb-3 border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-sm font-medium">
            {targetSet.usingFallback
              ? 'Scoring against the built-in defaults, not the table.'
              : 'Some stored targets were refused.'}
          </p>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-[var(--color-muted)]">
            {targetSet.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
            A target that cannot be read falls back to the value in code rather than to zero.
            Zero would read as a squad missing every target, which is the one wrong answer
            worth engineering against.
          </p>
        </Card>
      ) : null}

      <Card>
        <h3 className="text-sm font-semibold">In the squad score</h3>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
          Seven metrics across four equally weighted dimensions. <strong>bad</strong>
          {' is the value that scores 0 and '}
          <strong>good</strong>
          {' the value that scores 100; '}
          everything between is linear, and values past either end are clamped, so one spectacular
          week cannot buy back
          points lost elsewhere. A weight counts only within its own dimension, never across them.
          The two per-engineer rates were set from this org&apos;s own spread rather than from
          anything published, and are the most arguable numbers here — which is why they are the
          ones that most needed to stop requiring a deploy.
        </p>
        <div className="mt-2">
          {readOnly ? (
            <TargetReadout targets={scored} />
          ) : (
            scored.map((target) => (
              <MetricTargetForm key={target.key} action={action} target={target} />
            ))
          )}
        </div>
      </Card>

      <Card className="mt-3">
        <h3 className="text-sm font-semibold">Colour on the team pages only</h3>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
          These six decide whether a number on the measurement-framework page reads green, amber
          or red. They carry no weight because they are not in the composite, so moving one
          changes how a squad looks without changing where it ranks.
        </p>
        <div className="mt-2">
          {readOnly ? (
            <TargetReadout targets={colourOnly} />
          ) : (
            colourOnly.map((target) => (
              <MetricTargetForm key={target.key} action={action} target={target} />
            ))
          )}
        </div>
      </Card>

      <div className="mt-6">
        <SectionHeading
          title="Target change history"
          hint="Why this table exists: a squad's score dropping has two possible causes, and only one of them is the squad. Every row here is the other one."
        />
        {history.error ? (
          <Card className="mb-3 border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
            <p className="text-xs text-[var(--color-muted)]">
              The change history could not be read ({history.error}). The targets above are still
              current; only their provenance is missing.
            </p>
          </Card>
        ) : null}
        <Table
          empty="No target has been moved yet, so every score so far was measured against the values migration 0027 seeded from code."
          head={
            <>
              <Th>When</Th>
              <Th>Metric</Th>
              <Th>Change</Th>
              <Th>Direction of travel</Th>
              <Th>What it did to a squad that did not change</Th>
              <Th>Who, and why</Th>
            </>
          }
        >
          {history.changes.map((change) => (
            <tr key={change.id}>
              <Td className="whitespace-nowrap text-xs">
                {relativeDate(change.changedAt)}
                <div className="text-[11px] text-[var(--color-muted)]">
                  {change.changedAt.slice(0, 10)}
                </div>
              </Td>
              <Td className="text-xs">
                {change.label}
                <div className="font-mono text-[10px] text-[var(--color-muted)]">
                  {change.metricKey}
                </div>
              </Td>
              <Td className="tnum whitespace-nowrap text-xs">{change.summary}</Td>
              <Td>
                <Pill tone={SEVERITY_TONE[change.severity]}>{change.severity}</Pill>
                <div className="mt-1 max-w-56 text-[11px] leading-relaxed text-[var(--color-muted)]">
                  {SEVERITY_MEANING[change.severity]}
                </div>
              </Td>
              <Td className="max-w-64 text-[11px] leading-relaxed text-[var(--color-muted)]">
                {change.impact ?? 'Nothing — this end of the target does not move a score.'}
              </Td>
              <Td className="text-xs">
                {change.changedBy}
                {change.note ? (
                  <div className="mt-0.5 max-w-56 text-[11px] leading-relaxed text-[var(--color-muted)]">
                    “{change.note}”
                  </div>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
        <MetricNote>
          Recorded by a trigger on the table rather than by the form, so a threshold changed
          straight in SQL during an incident lands here too — as <code>unknown</code>, which is
          worse than a name and far better than a silent edit. The scores on{' '}
          <Link href="/outliers" className="underline">
            Outliers
          </Link>{' '}
          and{' '}
          <Link href="/rankings" className="underline">
            Rankings
          </Link>{' '}
          are recomputed from live data on every request, so a change here takes effect
          immediately and applies to the whole history — there is no snapshot of the old score to
          compare against, which is exactly why the before and after has to be written down.
        </MetricNote>
      </div>
    </section>
  )
}

/**
 * Any change to a target is a discontinuity in the series, so stricter and looser are
 * both flagged rather than one being coloured as good news. Which way it went is in
 * the label, and what that does is in SEVERITY_MEANING.
 */
const SEVERITY_TONE: Record<ChangeSeverity, 'neutral' | 'good' | 'warn' | 'bad'> = {
  stricter: 'warn',
  looser: 'warn',
  mixed: 'warn',
  reweighted: 'neutral',
  unchanged: 'neutral',
}

/** What a viewer sees where an admin gets inputs: the same numbers, not editable. */
function TargetReadout({ targets }: { targets: ResolvedTarget[] }) {
  // The unscored six have no weight, and a column of em-dashes says nothing that the
  // "not in the score" line under each name has not already said.
  const anyWeighted = targets.some((t) => t.weight !== null)
  return (
    <Table
      empty="No targets loaded."
      head={
        <>
          <Th>Metric</Th>
          <Th align="right" title="The value that scores 100">
            good
          </Th>
          <Th align="right" title="The value that scores 0">
            bad
          </Th>
          {anyWeighted ? <Th align="right">Weight</Th> : null}
          <Th>Last moved</Th>
        </>
      }
    >
      {targets.map((target) => (
        <tr key={target.key}>
          <Td className="text-xs">
            {target.label}
            <div className="text-[11px] text-[var(--color-muted)]">
              {target.direction === 'higher-better' ? 'higher is better' : 'lower is better'}
              {target.dimension ? ` · ${target.dimension}` : ' · not in the score'}
            </div>
          </Td>
          <Td align="right" numeric>
            {nf(target.good, target.good % 1 === 0 ? 0 : 2)}
          </Td>
          <Td align="right" numeric>
            {nf(target.bad, target.bad % 1 === 0 ? 0 : 2)}
          </Td>
          {anyWeighted ? (
            <Td align="right" numeric>
              {target.weight === null ? '—' : nf(target.weight)}
            </Td>
          ) : null}
          <Td className="text-xs text-[var(--color-muted)]">
            {target.updatedBy ? `${target.updatedBy} · ${relativeDate(target.updatedAt)}` : 'never'}
          </Td>
        </tr>
      ))}
    </Table>
  )
}
