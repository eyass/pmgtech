import Link from 'next/link'

import {
  CreateEngineerForm,
  LinkIdentityForm,
  RunSyncButtons,
  SenioritySelect,
  SquadSelect,
  ToggleButton,
} from '@/components/admin-forms'
import { Card, MetricNote, Pill, SectionHeading, SquadBadge, Table, Td, Th } from '@/components/ui'
import { currentUser } from '@/lib/auth'
import { integrationStatus } from '@/lib/env'
import { nf, relativeDate } from '@/lib/format'
import {
  getEngineers,
  getGitLabProjects,
  getJiraBoards,
  getSquads,
  getSyncRuns,
  getUnmatchedIdentities,
} from '@/lib/queries'
import { supabaseAdmin } from '@/lib/supabase/admin'

import {
  createEngineer,
  dismissIdentity,
  linkIdentity,
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

  const [squads, engineers, projects, boards, runs, unmatched, levels] = await Promise.all([
    getSquads(),
    getEngineers(),
    getGitLabProjects(),
    getJiraBoards(),
    getSyncRuns(15),
    getUnmatchedIdentities(),
    getSeniorityLevels(),
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
          hint="Squad and level come from HiBob. Overriding either here pins it, and future HiBob syncs will leave it alone."
        />
        <Table
          empty="No engineers yet. Run the HiBob sync to build the directory."
          head={
            <>
              <Th>Name</Th>
              <Th>HiBob title</Th>
              <Th>Squad</Th>
              <Th>Level</Th>
              <Th align="right">In metrics</Th>
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
