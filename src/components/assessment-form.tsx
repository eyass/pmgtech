'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import type { SaveResult } from '@/app/people/[id]/actions'
import type { AssessmentRow, AssessmentSummaryRow, PerformanceDimension } from '@/lib/types/performance'

/**
 * The human half of the framework. Deliberately asks for evidence next to every
 * rating — the server rejects a rating without it, because an unevidenced number
 * is not reviewable six months later and is exactly how review cycles turn into
 * recency bias.
 */
export function AssessmentForm({
  action,
  engineerId,
  engineerName,
  periodStart,
  periodEnd,
  periodLabel,
  dimensions,
  existing,
  summary,
}: {
  action: (formData: FormData) => Promise<SaveResult>
  engineerId: string
  engineerName: string
  periodStart: string
  periodEnd: string
  periodLabel: string
  dimensions: PerformanceDimension[]
  existing: AssessmentRow[]
  summary: AssessmentSummaryRow | null
}) {
  const [result, formAction] = useActionState<SaveResult | null, FormData>(
    async (_prev, formData) => action(formData),
    null,
  )

  const byDimension = new Map(existing.map((a) => [a.dimension_key, a]))
  const lastEdited = [...existing, ...(summary ? [summary] : [])]
    .map((r) => r.updated_at)
    .sort()
    .at(-1)

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="engineerId" value={engineerId} />
      <input type="hidden" name="periodStart" value={periodStart} />
      <input type="hidden" name="periodEnd" value={periodEnd} />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-[var(--color-muted)]">
          Assessment for <strong>{engineerName}</strong> — {periodLabel} ({periodStart} to{' '}
          {periodEnd})
        </p>
        {lastEdited ? (
          <p className="text-[11px] text-[var(--color-muted)]">
            Last saved {new Date(lastEdited).toLocaleString('en-GB')}
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        {dimensions.map((d) => {
          const prior = byDimension.get(d.key)
          return (
            <div key={d.key} className="rounded-lg border border-[var(--color-line)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-semibold">{d.name}</h4>
                  <p className="text-[11px] italic text-[var(--color-muted)]">
                    {d.individual_question}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--color-muted)]">Against level</span>
                  <select
                    name={`rating_${d.key}`}
                    defaultValue={prior?.rating?.toString() ?? ''}
                    className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs"
                  >
                    <option value="">Not rated</option>
                    <option value="1">1 — below expectations</option>
                    <option value="2">2 — approaching</option>
                    <option value="3">3 — meeting expectations</option>
                    <option value="4">4 — exceeding</option>
                    <option value="5">5 — well above</option>
                  </select>
                </label>
              </div>
              <textarea
                name={`evidence_${d.key}`}
                defaultValue={prior?.evidence ?? ''}
                rows={2}
                placeholder={
                  d.key === 'impact'
                    ? 'Required if rated. What did they actually move, and how do you know? This is the dimension the numbers cannot reach.'
                    : 'Required if rated. Specific examples — a merge request, an incident, a review that changed a design.'
                }
                className="mt-2 w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
              />
            </div>
          )
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field name="headline" label="Headline" defaultValue={summary?.headline ?? ''} placeholder="One sentence." />
        <Field name="strengths" label="Strengths" defaultValue={summary?.strengths ?? ''} placeholder="What to keep doing." />
        <Field name="growth" label="Growth" defaultValue={summary?.growth ?? ''} placeholder="One thing to work on." />
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton />
        <Status result={result} />
      </div>
    </form>
  )
}

function Field({
  name,
  label,
  defaultValue,
  placeholder,
}: {
  name: string
  label: string
  defaultValue: string
  placeholder: string
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <textarea
        name={name}
        defaultValue={defaultValue}
        rows={3}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
      />
    </label>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-surface)] disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save assessment'}
    </button>
  )
}

function Status({ result }: { result: SaveResult | null }) {
  const { pending } = useFormStatus()
  if (pending || !result) return null
  return (
    <span className={`text-xs ${result.ok ? 'text-emerald-600' : 'text-red-600'}`}>
      {result.message}
    </span>
  )
}
