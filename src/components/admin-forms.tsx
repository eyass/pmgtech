'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import type { ActionResult } from '@/app/admin/actions'
import { groupEngineerOptions, shouldGroup, type EngineerOption } from '@/lib/engineer-options'

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
  confirm,
}: {
  action: Action
  fields: Record<string, string>
  label: string
  title?: string
  /**
   * Ask before submitting. Used where the button moves numbers on every page —
   * ignoring a squad takes its people with it, and nothing on this row says so.
   */
  confirm?: string
}) {
  const [result, formAction] = useAction(action)

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault()
      }}
      className="flex items-center gap-2"
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton label={label} title={title} />
      <Status result={result} />
    </form>
  )
}

/**
 * The engineer list for an identity picker: everybody in the directory.
 *
 * Leavers and hand-added people are usually the answer rather than an edge case — an
 * account nobody has mapped tends to belong to someone who has already gone, and
 * their merge requests are still inside the reporting window. Current employees are
 * the more common pick, so they come first.
 *
 * Two things this got wrong before, both reported from the screen:
 *
 * - **The counts are in the labels.** With twenty current employees above them, the
 *   leavers were already in the list but nobody could tell: a native select gives no
 *   hint that a second group exists further down, so the picker looked like it only
 *   offered current staff. A count in each heading is what makes the rest findable.
 * - **Ignored people are offered too, and say what they cost.** They were filtered
 *   out entirely, which meant fifteen of this directory's forty-five engineers could
 *   not be picked and nothing on the screen said so. They are the right answer often
 *   enough to be worth offering; what matters is that choosing one has a consequence,
 *   so the group heading carries it rather than leaving it to be discovered later.
 */
function EngineerOptions({ engineers }: { engineers: EngineerOption[] }) {
  const options = (list: EngineerOption[]) =>
    list.map((engineer) => (
      <option key={engineer.id} value={engineer.id}>
        {engineer.name}
      </option>
    ))

  const groups = groupEngineerOptions(engineers)
  if (!shouldGroup(groups)) return <>{options(engineers)}</>

  return (
    <>
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {options(group.list)}
        </optgroup>
      ))}
    </>
  )
}

export function LinkIdentityForm({
  action,
  identityId,
  engineers,
}: {
  action: Action
  identityId: string
  engineers: EngineerOption[]
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
        <EngineerOptions engineers={engineers} />
      </select>
      <SubmitButton label="Link" />
      <Status result={result} />
    </form>
  )
}

/**
 * Pick an engineer for a commit-bridge candidate.
 *
 * Keyed on provider + external id rather than an unmatched_identities row, because a
 * bridge candidate can exist without one — the account may have been dismissed from
 * triage earlier, or only ever seen as a merge-request author.
 */
export function LinkBridgeForm({
  action,
  provider,
  externalId,
  handle,
  engineers,
}: {
  action: Action
  provider: string
  externalId: string
  handle: string
  engineers: EngineerOption[]
}) {
  const [result, formAction] = useAction(action)

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="externalId" value={externalId} />
      <input type="hidden" name="handle" value={handle} />
      <select
        name="engineerId"
        defaultValue=""
        aria-label="Link to engineer"
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs"
      >
        <option value="">Choose engineer…</option>
        <EngineerOptions engineers={engineers} />
      </select>
      <SubmitButton label="Link" />
      <Status result={result} />
    </form>
  )
}

/**
 * Add someone who is not in HiBob — a leaver whose commits are still in the
 * window, or a contractor. Email is optional but does the most work: commit author
 * emails match on it, so supplying one attributes their history immediately
 * instead of needing an identity linked by hand afterwards.
 */
export function CreateEngineerForm({
  action,
  squads,
  levels,
}: {
  action: Action
  squads: { id: string; name: string }[]
  levels: { key: string; label: string }[]
}) {
  const [result, formAction] = useAction(action)
  const field =
    'rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs'

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]">Full name (required)</span>
          <input name="fullName" required placeholder="Jane Doe" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]">
            Email — matches their commits
          </span>
          <input name="email" type="email" placeholder="jane@petmediagroup.com" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]">Job title</span>
          <input name="jobTitle" placeholder="Senior Software Engineer" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]">Level</span>
          <select name="seniorityKey" defaultValue="unknown" className={field}>
            {levels.map((level) => (
              <option key={level.key} value={level.key}>
                {level.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]">Squad</span>
          <select name="squadId" defaultValue="" className={field}>
            <option value="">Unassigned</option>
            {squads.map((squad) => (
              <option key={squad.id} value={squad.id}>
                {squad.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]">Status</span>
          <select name="isActive" defaultValue="false" className={field}>
            <option value="false">Former employee</option>
            <option value="true">Currently employed</option>
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <SubmitButton label="Add engineer" />
        <Status result={result} />
      </div>
      <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
        Sets the level and squad as manual, so a later HiBob sync will not overwrite
        them, and leaves the HiBob id empty so a sync never marks them a leaver.
        Former employees stay out of the within-level comparisons but their history
        still counts towards squad and team numbers.
      </p>
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

export type { EngineerOption }
