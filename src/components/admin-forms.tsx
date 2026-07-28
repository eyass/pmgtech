'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import type { ActionResult } from '@/app/admin/actions'

/**
 * Thin client wrappers around the admin server actions.
 *
 * Each control submits on change rather than needing a separate save button —
 * mapping thirty repositories to squads is tedious enough without an extra click
 * per row. The result message is rendered inline so a failure is visible next to
 * the thing that failed.
 */

type Action = (formData: FormData) => Promise<ActionResult>

function useAction(action: Action) {
  return useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => action(formData),
    null,
  )
}

function Status({ result }: { result: ActionResult | null }) {
  const { pending } = useFormStatus()
  if (pending) return <span className="text-xs text-[var(--color-muted)]">saving…</span>
  if (!result) return null
  return (
    <span className={`text-xs ${result.ok ? 'text-emerald-600' : 'text-red-600'}`}>
      {result.message}
    </span>
  )
}

export function SquadSelect({
  action,
  idField,
  idValue,
  currentSquadId,
  squads,
  label,
}: {
  action: Action
  idField: string
  idValue: string
  currentSquadId: string | null
  squads: { id: string; name: string }[]
  label: string
}) {
  const [result, formAction] = useAction(action)

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name={idField} value={idValue} />
      <select
        name="squadId"
        defaultValue={currentSquadId ?? ''}
        aria-label={label}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs"
      >
        <option value="">Unassigned</option>
        {squads.map((squad) => (
          <option key={squad.id} value={squad.id}>
            {squad.name}
          </option>
        ))}
      </select>
      <Status result={result} />
    </form>
  )
}

export function SenioritySelect({
  action,
  engineerId,
  current,
  levels,
}: {
  action: Action
  engineerId: string
  current: string
  levels: { key: string; label: string }[]
}) {
  const [result, formAction] = useAction(action)

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="engineerId" value={engineerId} />
      <select
        name="seniorityKey"
        defaultValue={current}
        aria-label="Seniority level"
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs"
      >
        {levels.map((level) => (
          <option key={level.key} value={level.key}>
            {level.label}
          </option>
        ))}
      </select>
      <Status result={result} />
    </form>
  )
}

export function ToggleButton({
  action,
  fields,
  label,
  title,
}: {
  action: Action
  fields: Record<string, string>
  label: string
  title?: string
}) {
  const [result, formAction] = useAction(action)

  return (
    <form action={formAction} className="flex items-center gap-2">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton label={label} title={title} />
      <Status result={result} />
    </form>
  )
}

export function LinkIdentityForm({
  action,
  identityId,
  engineers,
}: {
  action: Action
  identityId: string
  engineers: { id: string; name: string }[]
}) {
  const [result, formAction] = useAction(action)

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="identityId" value={identityId} />
      <select
        name="engineerId"
        defaultValue=""
        aria-label="Link to engineer"
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs"
      >
        <option value="">Choose engineer…</option>
        {engineers.map((engineer) => (
          <option key={engineer.id} value={engineer.id}>
            {engineer.name}
          </option>
        ))}
      </select>
      <SubmitButton label="Link" />
      <Status result={result} />
    </form>
  )
}

function SubmitButton({ label, title }: { label: string; title?: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      title={title}
      className="rounded-md border border-[var(--color-line)] px-2 py-1 text-xs transition-colors hover:bg-[var(--color-line)] disabled:opacity-50"
    >
      {label}
    </button>
  )
}

/**
 * Kicks off a sync and shows the resulting summary. Deliberately not a server
 * action: a backfill can run for minutes and the response body is the useful
 * artefact, so it is easier to read from the route handler directly.
 */
export function RunSyncButtons() {
  return (
    <div className="flex flex-wrap gap-2">
      <SyncButton label="Sync all (incremental)" href="/api/sync?source=all" />
      <SyncButton label="HiBob only" href="/api/sync?source=hibob" />
      <SyncButton label="Jira only" href="/api/sync?source=jira" />
      <SyncButton label="GitLab only" href="/api/sync?source=gitlab" />
      <SyncButton
        label="Full backfill"
        href="/api/sync?source=all&mode=backfill"
        title="Ignores stored cursors and pulls the whole configured window. Safe to run repeatedly — it resumes where it left off."
      />
    </div>
  )
}

function SyncButton({ label, href, title }: { label: string; href: string; title?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-line)]"
    >
      {label}
    </a>
  )
}
