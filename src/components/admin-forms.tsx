'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import type { ActionResult } from '@/app/admin/actions'
import { groupEngineerOptions, shouldGroup, type EngineerOption } from '@/lib/engineer-options'
import { validateTarget, type ResolvedTarget } from '@/lib/targets'
import { presence, validateStartDate } from '@/lib/tenure'

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
 * Edit one delivery target.
 *
 * The heaviest control on this screen, and the only one whose blast radius is every
 * squad at once. `ToggleButton`'s confirm exists because ignoring a squad takes its
 * people with it and nothing on the row says so; this is the same problem one level
 * up — moving a threshold moves the score of squads that did not change, which is
 * exactly the misreading the audit trail is there to prevent. So it gets the same
 * friction, with the actual before-and-after in the prompt rather than a generic
 * warning, and Save stays disabled until something is genuinely different.
 *
 * `direction` is displayed but not editable: whether lower cycle time is better is
 * a fact about the metric. It rides along as a hidden field so the client-side
 * check can refuse an inverted pair before the round trip, matching the constraint
 * in migration 0027.
 */
export function MetricTargetForm({
  action,
  target,
}: {
  action: Action
  target: ResolvedTarget
}) {
  const [result, formAction] = useAction(action)
  const [good, setGood] = useState(String(target.good))
  const [bad, setBad] = useState(String(target.bad))
  const [weight, setWeight] = useState(target.weight === null ? '' : String(target.weight))
  const [refusal, setRefusal] = useState<string | null>(null)

  const scored = target.dimension !== null
  const changed =
    Number(good) !== target.good ||
    Number(bad) !== target.bad ||
    (scored && Number(weight) !== target.weight)

  const number =
    'tnum w-20 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs'

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const check = validateTarget({
          direction: target.direction,
          good: Number(good),
          bad: Number(bad),
          label: target.label,
        })
        if (!check.ok) {
          setRefusal(check.message)
          event.preventDefault()
          return
        }
        setRefusal(null)
        // Only what actually moved. "bad 1 \u2192 1" in a confirmation dialog is noise, and
        // noise in a confirmation is how people learn to click through them.
        const lines = [
          `Move the target for ${target.label}?`,
          '',
          Number(good) !== target.good ? `good ${target.good} \u2192 ${Number(good)}` : '',
          Number(bad) !== target.bad ? `bad ${target.bad} \u2192 ${Number(bad)}` : '',
          scored && Number(weight) !== target.weight
            ? `weight ${target.weight} \u2192 ${Number(weight)}`
            : '',
          '',
          scored
            ? 'Every squad is scored against this threshold, so every squad\u2019s score moves \u2014 including squads that have not changed at all.'
            : 'This colours the metric on the team pages for every squad.',
          'The edit is recorded against your email in the change history below, which is what will tell this apart from a squad getting worse.',
        ].filter(Boolean)
        if (!window.confirm(lines.join('\n'))) event.preventDefault()
      }}
      className="grid items-start gap-x-4 gap-y-2 border-b border-[var(--color-line)] py-3 last:border-0 md:grid-cols-[minmax(0,1fr)_auto]"
    >
      <input type="hidden" name="metricKey" value={target.key} />
      <input type="hidden" name="label" value={target.label} />
      <input type="hidden" name="direction" value={target.direction} />
      <input type="hidden" name="scored" value={String(scored)} />

      <div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{target.label}</span>
          <span className="font-mono text-[10px] text-[var(--color-muted)]">{target.key}</span>
          {target.source === 'fallback' ? (
            <span
              className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title="No usable row in metric_targets, so the built-in default is what the app is scoring against."
            >
              built-in default
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
          {target.direction === 'higher-better' ? 'Higher is better' : 'Lower is better'}
          {scored ? ` \u00b7 feeds ${target.dimension}` : ' \u00b7 not in the score'}
          {' \u00b7 '}
          {target.updatedBy
            ? `moved by ${target.updatedBy}${
                target.updatedAt ? ` on ${target.updatedAt.slice(0, 10)}` : ''
              }`
            : 'never edited'}
        </p>
        {target.rationale ? (
          <p className="mt-0.5 max-w-prose text-[11px] leading-relaxed text-[var(--color-muted)]">
            {target.rationale}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]" title="Scores 100">
            good
          </span>
          <input
            name="good"
            type="number"
            step="any"
            required
            value={good}
            onChange={(event) => setGood(event.currentTarget.value)}
            aria-label={`${target.label}: the value that scores 100`}
            className={number}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]" title="Scores 0">
            bad
          </span>
          <input
            name="bad"
            type="number"
            step="any"
            required
            value={bad}
            onChange={(event) => setBad(event.currentTarget.value)}
            aria-label={`${target.label}: the value that scores 0`}
            className={number}
          />
        </label>
        {scored ? (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--color-muted)]">weight</span>
            <input
              name="weight"
              type="number"
              step="any"
              min="0.1"
              required
              value={weight}
              onChange={(event) => setWeight(event.currentTarget.value)}
              aria-label={`${target.label}: weight within its dimension`}
              className={number}
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--color-muted)]">Why (recorded)</span>
          <input
            name="note"
            placeholder="The most useful thing here in six months"
            aria-label={`${target.label}: reason for the change`}
            className="w-64 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs"
          />
        </label>
        <SubmitButton
          label="Save"
          title={changed ? 'Moves every squad\u2019s score' : 'Nothing has changed yet'}
          disabled={!changed}
        />
      </div>

      {/* Full width, so a long refusal wraps under the row instead of squeezing the inputs. */}
      <div className="text-xs md:col-span-2">
        {refusal ? <span className="text-red-600">{refusal}</span> : <Status result={result} />}
      </div>
    </form>
  )
}

/**
 * Set or correct one engineer's employment start date.
 *
 * The second control on this screen whose blast radius is other people. Since
 * migration 0028 a start date decides how much of the window an engineer's counting
 * metrics are divided by, and whether their row is allowed into their cohort's
 * median at all — so an edit here moves that person's score *and* shifts the median
 * every peer at their level is measured against. `ToggleButton`'s `confirm` exists
 * for exactly this shape of thing (ignoring a squad takes its people with it and
 * nothing on the row says so), and `MetricTargetForm` already applies it to an edit
 * with an input rather than a fixed payload. This does the same, with three
 * particulars:
 *
 *   - the confirmation states the before, the after and the presence each implies,
 *     because "90 of 90 days becomes 11 of 90" is the consequence and the date on
 *     its own is not;
 *   - Save is disabled until the value actually differs, so the dialog never fires
 *     on a no-op — a confirmation people learn to click through is worse than none;
 *   - the date is validated client-side against the same rule the server action
 *     uses, so an impossible date is refused without a round trip.
 *
 * A HiBob-sourced date is editable, not read-only. The point is to correct a wrong
 * one as much as to fill a missing one, and saving pins it as manual so the next
 * sync leaves the correction alone.
 */
export function StartDateForm({
  action,
  engineerId,
  name,
  current,
  source,
  windowFrom,
  windowTo,
}: {
  action: Action
  engineerId: string
  name: string
  current: string | null
  source: 'unknown' | 'hibob' | 'manual'
  /** The window presence is previewed against — the 90 days the scores are read over. */
  windowFrom: string
  windowTo: string
}) {
  const [result, formAction] = useAction(action)
  const [value, setValue] = useState(current ?? '')
  const [refusal, setRefusal] = useState<string | null>(null)

  const normalised = value.trim()
  const changed = normalised !== (current ?? '')

  const describe = (date: string | null) => {
    if (!date) return 'no start date — presence unknown, held out of the cohort median'
    const p = presence(date, windowFrom, windowTo)
    if (p.notYetPresent) return 'not started yet in this window — no score at all'
    return `present ${p.daysPresent} of ${p.windowDays} days${
      p.inCohortMedian ? '' : ', held out of the cohort median'
    }`
  }

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (normalised !== '') {
          const check = validateStartDate(normalised)
          if (!check.ok) {
            setRefusal(check.message)
            event.preventDefault()
            return
          }
        }
        setRefusal(null)
        const lines = [
          `Change ${name}'s start date?`,
          '',
          `${current ?? 'none'} → ${normalised === '' ? 'none' : normalised}`,
          `${describe(current)}`,
          `→ ${describe(normalised === '' ? null : normalised)}`,
          '',
          'This moves their score, and it moves the median every engineer at their level is scored against — including people who have not changed at all.',
          'Saving marks the date as set by hand, so the next HiBob sync will leave it alone.',
        ]
        if (!window.confirm(lines.join('\n'))) event.preventDefault()
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="engineerId" value={engineerId} />
      <input
        name="startDate"
        type="date"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        aria-label={`Start date for ${name}`}
        className="tnum rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs"
      />
      <SubmitButton
        label="Save"
        title={
          changed
            ? 'Moves their score and their whole cohort’s median'
            : 'Nothing has changed yet'
        }
        disabled={!changed}
      />
      <span className="text-[11px] text-[var(--color-muted)]">
        {source === 'manual'
          ? 'set by hand'
          : source === 'hibob'
            ? 'from HiBob'
            : 'no source on record'}
      </span>
      {refusal ? (
        <span className="text-xs text-red-600">{refusal}</span>
      ) : (
        <Status result={result} />
      )}
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

function SubmitButton({
  label,
  title,
  disabled,
}: {
  label: string
  title?: string
  disabled?: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || disabled}
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
