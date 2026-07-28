import Link from 'next/link'

import {
  CreateEngineerForm,
  LinkBridgeForm,
  LinkIdentityForm,
  RunSyncButtons,
  SenioritySelect,
  SquadSelect,
  ToggleButton,
} from '@/components/admin-forms'
import { Card, MetricNote, Pill, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { currentUser } from '@/lib/auth'
import { integrationStatus } from '@/lib/env'
import { nf, pct, relativeDate } from '@/lib/format'
import {
  getEngineers,
  getGitLabProjects,
  getJiraBoards,
  getSquads,
  getBridgeSuggestions,
  getSquadSuggestions,
  getSyncRuns,
  getUnmatchedIdentities,
} from '@/lib/queries'
import { supabaseAdmin } from '@/lib/supabase/admin'

import {
  createEngineer,
  dismissIdentity,
  linkBridgeCandidate,
  linkIdentity,
  markBridgeCandidateAsBot,
  markEngineerAsBot,
  markIdentityAsBot,
  setBoardSquad,
  setEngineerSeniority,
  setEngineerSquad,
  setProjectSquad,
  toggleEngineerMetrics,
  toggleProjectTracked,
} from './actions'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const user = await currentUser()
  const readOnly = !user?.isAdmin

  const [squads, engineers, projects, boards, runs, unmatched, levels, bridge, squadHints] =
    await Promise.all([
      getSquads(),
      getEngineers(),
      getGitLabProjects(),
      getJiraBoards(),
      getSyncRuns(15),
      getUnmatchedIdentities(),
      getSeniorityLevels(),
      getBridgeSuggestions(),
      getSquadSuggestions(),
    ])

  const status = integrationStatus()
  const squadOptions = squads.map((s) => ({ id: s.id, name: s.name }))
  const engineerOptions = engineers
    .filter((e) => e.is_active)
    .map((e) => ({ id: e.id, name: `${e.display_name ?? e.full_name}${e.email ? ` (${e.email})` : ''}` }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Admin</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Connections, mappings and sync history.
          {readOnly ? ' You have viewer access, so changes are disabled.' : ''}
        </p>
      </div>

      {/* --- integrations ----------------------------------------------------- */}

      <section>
        <SectionHeading title="Integrations" />
        <div className="grid gap-3 sm:grid-cols-3">
          {(['gitlab', 'jira', 'hibob'] as const).map((name) => (
            <Card key={name}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium capitalize">{name}</span>
                <Pill tone={status[name].configured ? 'good' : 'warn'}>
                  {status[name].configured ? 'configured' : 'incomplete'}
                </Pill>
              </div>
              {status[name].configured ? (
                <p className="mt-2 text-xs text-[var(--color-muted)]">
                  Credentials present. Run a sync to verify access.
                </p>
              ) : (
                <p className="mt-2 text-xs text-[var(--color-muted)]">
                  Missing:{' '}
                  <code className="rounded bg-[var(--color-line)] px-1 py-0.5">
                    {status[name].missing.join(', ')}
                  </code>
                </p>
              )}
            </Card>
          ))}
        </div>
      </section>

      {/* --- run a sync ------------------------------------------------------- */}

      {!readOnly ? (
        <section>
          <SectionHeading
            title="Run a sync"
            hint="Opens the sync endpoint in a new tab and returns a JSON summary. A cron job also runs every three hours."
          />
          <Card>
            <RunSyncButtons />
            <MetricNote>
              A first backfill of twelve months will not finish in one request — each merge request
              costs several GitLab API calls. The sync stops cleanly when it runs out of time and
              records its progress, so pressing <strong>Full backfill</strong> a few times (or
              waiting for the cron) walks steadily through the history without duplicating work.
            </MetricNote>
          </Card>
        </section>
      ) : null}

      {/* --- squad suggestions ------------------------------------------------ */}

      {squadHints.length > 0 ? (
        <section>
          <SectionHeading
            title="Suggested squads"
            hint="Engineers with no squad, and the squad whose Jira board their issues actually sit on. Until a squad is set, their work reaches a person but no team, which is why a squad total can be lower than the sum of its people."
          />
          <Table
            empty="Everyone has a squad."
            head={
              <>
                <Th>Engineer</Th>
                <Th>Suggested squad</Th>
                <Th align="right" title="Issues on that squad's boards, out of all their board work">
                  Board work
                </Th>
                <Th align="right" title="Merged merge requests that would move with them">
                  Merged MRs
                </Th>
                <Th>Assign</Th>
              </>
            }
          >
            {squadHints.map((hint) => (
              <tr key={hint.engineer_id}>
                <Td>
                  <Link href={`/people/${hint.engineer_id}`} className="hover:underline">
                    {hint.full_name}
                  </Link>
                  <div className="text-xs text-[var(--color-muted)]">{hint.job_title ?? '—'}</div>
                </Td>
                <Td>
                  <SquadBadge squadKey={hint.squad_key} name={hint.squad_name} />
                </Td>
                <Td align="right" numeric>
                  {nf(hint.issues)}/{nf(hint.total_issues)}
                  <div className="text-xs text-[var(--color-muted)]">{pct(hint.share_pct)}</div>
                </Td>
                <Td align="right" numeric>{nf(hint.mrs)}</Td>
                <Td>
                  {readOnly ? (
                    <span className="text-xs text-[var(--color-muted)]">admin only</span>
                  ) : (
                    <ToggleButton
                      action={setEngineerSquad}
                      fields={{ engineerId: hint.engineer_id, squadId: hint.squad_id }}
                      label={`Assign to ${hint.squad_name}`}
                      title="Sets the squad manually, so a later HiBob sync will not overwrite it"
                    />
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <MetricNote>
            HiBob cannot answer this — every engineer&rsquo;s department here is the single value
            &ldquo;Tech&rdquo; — and neither can the repository, which the dashboard otherwise
            falls back to: this org has one tracked project, a monorepo that three squads work in
            at roughly 41/37/22%, so attributing it to any one team would be wrong for most of its
            work. The Jira board is the only signal that separates them, and it only became
            available once Jira accounts were linked to people.
          </MetricNote>
        </section>
      ) : null}

      {/* --- commit bridge suggestions ---------------------------------------- */}

      {bridge.length > 0 ? (
        <section>
          <SectionHeading
            title="Suggested links from commit history"
            hint="GitLab exposes no email for most accounts here, but the commits inside their merge requests do. Where that evidence was unambiguous the sync already linked the account; these are the ones it would not act on alone."
          />
          <Table
            empty="Nothing to review."
            head={
              <>
                <Th>GitLab account</Th>
                <Th>Dominant commit author</Th>
                <Th align="right" title="Merge requests where this email authored the most commits, out of all their merge requests">
                  Evidence
                </Th>
                <Th>Why it needs a look</Th>
                <Th>Action</Th>
              </>
            }
          >
            {bridge.map((row) => (
              <tr key={`${row.provider}:${row.externalId}`}>
                <Td>
                  {row.displayName ?? row.handle ?? '—'}
                  <div className="font-mono text-xs text-[var(--color-muted)]">
                    {row.handle ? `${row.handle} · ` : ''}
                    {row.externalId}
                  </div>
                </Td>
                <Td className="text-xs">
                  <span className="font-mono">{row.email}</span>
                  {row.engineerName ? (
                    <div className="text-[var(--color-muted)]">{row.engineerName}</div>
                  ) : (
                    <div className="text-[var(--color-muted)]">no engineer with this address</div>
                  )}
                </Td>
                <Td align="right" numeric>
                  {nf(row.mrsWon)}/{nf(row.mrs)} MRs
                  <div className="text-xs text-[var(--color-muted)]">{nf(row.commits)} commits</div>
                </Td>
                <Td className="max-w-sm text-xs text-[var(--color-muted)]">
                  {row.verdict.reason}
                </Td>
                <Td>
                  {readOnly ? (
                    <span className="text-xs text-[var(--color-muted)]">admin only</span>
                  ) : row.verdict.action === 'suggest-bot' ? (
                    <ToggleButton
                      action={markBridgeCandidateAsBot}
                      fields={{
                        provider: row.provider,
                        externalId: row.externalId,
                        label: row.displayName ?? row.handle ?? row.externalId,
                      }}
                      label="It's a bot"
                      title="Exclude this account from metrics. Its merge requests stop counting against attribution coverage."
                    />
                  ) : row.verdict.action === 'suggest-link' ? (
                    <ToggleButton
                      action={linkBridgeCandidate}
                      fields={{
                        provider: row.provider,
                        externalId: row.externalId,
                        engineerId: row.verdict.engineerId,
                        handle: row.handle ?? row.displayName ?? '',
                      }}
                      label={`Link to ${row.engineerName ?? 'engineer'}`}
                      title="Write the link and re-attribute their history"
                    />
                  ) : row.verdict.action === 'suggest-manual' ? (
                    <LinkBridgeForm
                      action={linkBridgeCandidate}
                      provider={row.provider}
                      externalId={row.externalId}
                      handle={row.handle ?? row.displayName ?? ''}
                      engineers={engineerOptions}
                    />
                  ) : (
                    <div className="space-y-1">
                      <LinkBridgeForm
                        action={linkBridgeCandidate}
                        provider={row.provider}
                        externalId={row.externalId}
                        handle={row.handle ?? row.displayName ?? ''}
                        engineers={engineerOptions}
                      />
                      <p className="text-xs text-[var(--color-muted)]">
                        Or add them under “Add an engineer” with this address, and their history
                        attributes on its own.
                      </p>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <MetricNote>
            The measure is per-merge-request dominance, not total commit share: for each merge
            request, which address authored the most commits in it, and in how many of the
            account&rsquo;s merge requests the same address won. That distinction matters — one
            account here has merge requests 63% authored by an unrelated person, from a rebase or a
            taken-over branch, which total commit share cannot tell apart from a real link. Links
            are written unattended only above 80% dominance across at least three merge requests
            <em> and</em> when the two names agree; name agreement never creates a link on its own.
          </MetricNote>
        </section>
      ) : null}

      {/* --- unmatched identities --------------------------------------------- */}

      <section>
        <SectionHeading
          title="Unmapped identities"
          hint="GitLab and Jira accounts whose email did not match anyone in HiBob. Until they are linked, their work is not attributed to a person or a squad."
        />
        <Table
          empty="Everything is attributed — no unmapped identities."
          head={
            <>
              <Th>Source</Th>
              <Th>Identity</Th>
              <Th>Email</Th>
              <Th align="right" title="How many events we have seen from this identity">
                Events
              </Th>
              <Th align="right">Last seen</Th>
              <Th>Link to</Th>
            </>
          }
        >
          {unmatched.map((identity) => (
            <tr key={identity.id}>
              <Td>
                <Pill>{identity.provider}</Pill>
              </Td>
              <Td>
                {identity.display_name ?? identity.external_handle ?? '—'}
                <div className="font-mono text-xs text-[var(--color-muted)]">
                  {identity.external_id}
                </div>
              </Td>
              <Td className="text-xs">{identity.email ?? '—'}</Td>
              <Td align="right" numeric>{nf(identity.event_count)}</Td>
              <Td align="right">{relativeDate(identity.last_seen_at)}</Td>
              <Td>
                {readOnly ? (
                  <span className="text-xs text-[var(--color-muted)]">admin only</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <LinkIdentityForm
                      action={linkIdentity}
                      identityId={identity.id}
                      engineers={engineerOptions}
                    />
                    <ToggleButton
                      action={markIdentityAsBot}
                      fields={{ identityId: identity.id }}
                      label="It's a bot"
                      title="Exclude from review analysis — an AI reviewer or CI bot commenting on every merge request otherwise makes time-to-first-review meaningless"
                    />
                    <ToggleButton
                      action={dismissIdentity}
                      fields={{ identityId: identity.id }}
                      label="Dismiss"
                      title="Just hide this identity from triage; does not change any metric"
                    />
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      {/* --- engineers -------------------------------------------------------- */}

      <section>
        <SectionHeading
          title="Add an engineer"
          hint="For people who are not in HiBob — someone who has left but whose commits are still in the window, or a contractor. Give an email and their history attributes straight away."
        />
        <Card>
          {readOnly ? (
            <p className="text-xs text-[var(--color-muted)]">Admin access required.</p>
          ) : (
            <CreateEngineerForm action={createEngineer} squads={squads} levels={levels} />
          )}
        </Card>
      </section>

      <section>
        <SectionHeading
          title="Engineers"
          hint="Squad, level and metric inclusion come from HiBob. Overriding any of them here pins it, and future HiBob syncs will leave it alone."
        />
        <Table
          empty="No engineers yet. Run the HiBob sync to build the directory."
          head={
            <>
              <Th>Name</Th>
              <Th>HiBob title</Th>
              <Th>Squad</Th>
              <Th>Level</Th>
              <Th align="right" title="Whether this person counts towards headcount and per-engineer rates. Their merge requests, reviews and commits count towards their squad either way.">
                In metrics
              </Th>
              <Th align="right">Automation</Th>
              <Th align="right">Status</Th>
            </>
          }
        >
          {engineers.map((engineer) => (
            <tr key={engineer.id}>
              <Td>
                <Link href={`/people/${engineer.id}`} className="hover:underline">
                  {engineer.display_name ?? engineer.full_name}
                </Link>
                <div className="text-xs text-[var(--color-muted)]">{engineer.email ?? 'no email'}</div>
              </Td>
              <Td className="text-xs">{engineer.job_title ?? '—'}</Td>
              <Td>
                {readOnly ? (
                  <SquadBadge
                    squadKey={squads.find((s) => s.id === engineer.squad_id)?.key ?? null}
                    name={squads.find((s) => s.id === engineer.squad_id)?.name ?? 'Unassigned'}
                  />
                ) : (
                  <SquadSelect
                    action={setEngineerSquad}
                    idField="engineerId"
                    idValue={engineer.id}
                    currentSquadId={engineer.squad_id}
                    squads={squadOptions}
                    label={`Squad for ${engineer.full_name}`}
                  />
                )}
              </Td>
              <Td>
                {readOnly ? (
                  <span className="text-xs">{engineer.seniority_key}</span>
                ) : (
                  <SenioritySelect
                    action={setEngineerSeniority}
                    engineerId={engineer.id}
                    current={engineer.seniority_key}
                    levels={levels}
                  />
                )}
              </Td>
              <Td align="right">
                {readOnly ? (
                  <Pill tone={engineer.include_in_metrics ? 'good' : 'neutral'}>
                    {engineer.include_in_metrics ? 'yes' : 'no'}
                  </Pill>
                ) : (
                  <ToggleButton
                    action={toggleEngineerMetrics}
                    fields={{
                      engineerId: engineer.id,
                      include: String(!engineer.include_in_metrics),
                    }}
                    label={engineer.include_in_metrics ? 'Exclude' : 'Include'}
                    title="Excluded people keep their history but drop out of headcount and per-engineer rates"
                  />
                )}
                {/* Say which excluded people were excluded by the title rule rather than by
                    someone's decision, so a wrong default is visibly a default. */}
                {!engineer.include_in_metrics ? (
                  <div className="mt-1 text-[11px] text-[var(--color-muted)]">
                    {engineer.include_in_metrics_source === 'manual'
                      ? 'set by hand'
                      : 'non-IC title'}
                  </div>
                ) : null}
              </Td>
              <Td align="right">
                {readOnly ? (
                  <span className="text-xs text-[var(--color-muted)]">—</span>
                ) : (
                  <ToggleButton
                    action={markEngineerAsBot}
                    fields={{ engineerId: engineer.id }}
                    label="It's a bot"
                    title="Not a person: excludes its GitLab and Jira accounts from review analysis, drops it from metrics and cohorts, and re-derives affected history"
                  />
                )}
              </Td>
              <Td align="right">
                <Pill tone={engineer.is_active ? 'good' : 'neutral'}>
                  {engineer.is_active ? 'active' : 'inactive'}
                </Pill>
              </Td>
            </tr>
          ))}
        </Table>
        <MetricNote>
          <strong>In metrics</strong> controls the denominator, not the data. Managers and
          leadership default to excluded from their HiBob title — an engineering manager who
          ships two merge requests a month is doing their job, and averaging them in with eight
          ICs makes the squad look 20% slower than it is. Nothing they shipped is dropped: their
          merge requests, reviews and commits still count towards their squad and still appear on
          their own profile. Toggling it here pins the choice against later syncs.
        </MetricNote>
      </section>

      {/* --- Jira boards ------------------------------------------------------ */}

      <section>
        <SectionHeading
          title="Jira boards"
          hint="Mapping a board to a squad is what makes sprint metrics work. Existing sprints on the board are updated immediately."
        />
        <Table
          empty="No boards yet. Run the Jira sync."
          head={
            <>
              <Th>Board</Th>
              <Th>Type</Th>
              <Th>Project</Th>
              <Th>Squad</Th>
            </>
          }
        >
          {boards.map((board) => (
            <tr key={board.id}>
              <Td>{board.name}</Td>
              <Td className="text-xs">{board.board_type ?? '—'}</Td>
              <Td className="text-xs">{board.project_key ?? '—'}</Td>
              <Td>
                {readOnly ? (
                  <SquadBadge
                    squadKey={squads.find((s) => s.id === board.squad_id)?.key ?? null}
                    name={squads.find((s) => s.id === board.squad_id)?.name ?? 'Unassigned'}
                  />
                ) : (
                  <SquadSelect
                    action={setBoardSquad}
                    idField="boardId"
                    idValue={board.id}
                    currentSquadId={board.squad_id}
                    squads={squadOptions}
                    label={`Squad for board ${board.name}`}
                  />
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      {/* --- GitLab projects -------------------------------------------------- */}

      <section>
        <SectionHeading
          title="GitLab repositories"
          hint="A repository's squad is the fallback for activity whose author we cannot resolve. Untracked repositories are skipped by the sync entirely."
        />
        <Table
          empty="No repositories yet. Run the GitLab sync."
          head={
            <>
              <Th>Repository</Th>
              <Th align="right">Last activity</Th>
              <Th>Owning squad</Th>
              <Th align="right">Synced</Th>
            </>
          }
        >
          {projects.map((project) => (
            <tr key={project.id}>
              <Td>
                {project.name}
                <div className="font-mono text-xs text-[var(--color-muted)]">
                  {project.path_with_namespace}
                </div>
              </Td>
              <Td align="right">{relativeDate(project.last_activity_at)}</Td>
              <Td>
                {readOnly ? (
                  <SquadBadge
                    squadKey={squads.find((s) => s.id === project.squad_id)?.key ?? null}
                    name={squads.find((s) => s.id === project.squad_id)?.name ?? 'Unassigned'}
                  />
                ) : (
                  <SquadSelect
                    action={setProjectSquad}
                    idField="projectId"
                    idValue={project.id}
                    currentSquadId={project.squad_id}
                    squads={squadOptions}
                    label={`Squad for ${project.name}`}
                  />
                )}
              </Td>
              <Td align="right">
                {readOnly ? (
                  <Pill tone={project.is_tracked ? 'good' : 'neutral'}>
                    {project.is_tracked ? 'yes' : 'no'}
                  </Pill>
                ) : (
                  <ToggleButton
                    action={toggleProjectTracked}
                    fields={{ projectId: project.id, tracked: String(!project.is_tracked) }}
                    label={project.is_tracked ? 'Stop' : 'Start'}
                  />
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      {/* --- sync history ----------------------------------------------------- */}

      <section>
        <SectionHeading title="Sync history" />
        <Table
          empty="No syncs have run yet."
          head={
            <>
              <Th>Source</Th>
              <Th>Mode</Th>
              <Th>Trigger</Th>
              <Th>Status</Th>
              <Th align="right">Started</Th>
              <Th align="right">Duration</Th>
              <Th>Result</Th>
            </>
          }
        >
          {runs.map((run) => (
            <tr key={run.id}>
              <Td className="capitalize">{run.source}</Td>
              <Td className="text-xs">{run.mode}</Td>
              <Td className="text-xs">{run.trigger}</Td>
              <Td>
                <Pill
                  tone={
                    run.status === 'success'
                      ? 'good'
                      : run.status === 'error'
                        ? 'bad'
                        : run.status === 'partial'
                          ? 'warn'
                          : 'neutral'
                  }
                >
                  {run.status}
                </Pill>
              </Td>
              <Td align="right">{relativeDate(run.started_at)}</Td>
              <Td align="right" numeric>
                {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : '—'}
              </Td>
              <Td className="max-w-md">
                {run.error ? (
                  <span className="text-xs text-red-600 dark:text-red-400">{run.error}</span>
                ) : (
                  <span className="text-xs text-[var(--color-muted)]">{summarise(run.stats)}</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  )
}

function summarise(stats: Record<string, unknown>): string {
  const parts = Object.entries(stats)
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`)
  return parts.length > 0 ? parts.join(' · ') : 'nothing changed'
}

async function getSeniorityLevels(): Promise<{ key: string; label: string }[]> {
  const { data, error } = await supabaseAdmin()
    .from('seniority_levels')
    .select('key, label, rank')
    .order('rank', { ascending: false })
  if (error) throw new Error(`Failed to load seniority levels: ${error.message}`)
  return (data ?? []) as { key: string; label: string }[]
}
