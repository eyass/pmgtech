import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  orgWithholdings,
  readAttribution,
  readCron,
  readScored,
  readSourceHealth,
  readVerdict,
  readWindowCoverage,
  type SourceHealth,
  type StreamFrontier,
  type SyncRunFacts,
} from '../src/lib/trust.ts'
import type { OrgKpis } from '../src/lib/types/metrics.ts'
import type { EngineerOutlier } from '../src/lib/types/performance.ts'

/**
 * The trust page's whole value is that it agrees with the banners it summarises, and
 * that it never dresses an unknown up as a number. Both are properties of this
 * module rather than of the rendering, so both are pinned here.
 *
 * The sync cases are the ones that earned their tests: the alert wording is what the
 * banner on every page prints, and it used to be computed inside the query. Moving
 * it here without changing a word is the only reason the refactor is safe.
 */

const KPIS: OrgKpis = {
  headcount: 14,
  unassigned_engineers: 0,
  unmapped_identities: 21,
  merged_mrs: 1472,
  open_mrs: 17,
  median_cycle_hours: 17.7,
  median_review_wait_hours: 1.2,
  review_coverage_pct: 99.9,
  mrs_per_engineer_week: 8.18,
  prod_deploys: 449,
  deploys_per_week: 34.92,
  change_failure_pct: 16.4,
  mttr_hours: 0.5,
  deploy_coverage_pct: 53.5,
  issues_resolved: 2173,
  story_points: null,
  story_points_coverage_pct: 9.2,
  median_issue_cycle_hours: 25.5,
  bug_ratio_pct: 24.3,
  reviews_given: 1861,
  cycle_sample: 1472,
  review_wait_sample: 1471,
  review_coverage_sample: 1472,
  deploy_sample: 537,
  mttr_sample: 87,
  story_points_sample: 199,
  issue_cycle_sample: 1689,
  mr_attribution_pct: 80.2,
  commit_attribution_pct: 80.1,
  unattributed_mrs: 292,
}

describe('readAttribution', () => {
  it('takes the worse of the two figures, which is what the banner states', () => {
    const read = readAttribution(KPIS)
    assert.equal(read.worst, 80.1)
    assert.equal(read.level, 'warn')
    assert.equal(read.material, true)
  })

  it('treats an unmeasured figure as unknown rather than as 100%', () => {
    const read = readAttribution({
      ...KPIS,
      mr_attribution_pct: null,
      commit_attribution_pct: null,
    })
    assert.equal(read.worst, null)
    assert.equal(read.known, false)
    assert.equal(read.level, 'unknown')
    // The banner keys off `material` to decide whether to render, and an unmeasured
    // gap is not something to interrupt about — but it is not 'ok' either.
    assert.equal(read.material, false)
  })

  it('ignores a null on one side without letting it stand in for a perfect score', () => {
    const read = readAttribution({ ...KPIS, mr_attribution_pct: null })
    assert.equal(read.worst, 80.1)
    assert.equal(read.partial, true)
  })

  it('calls a gap immaterial above the noise floor, so the banner stays away', () => {
    const read = readAttribution({
      ...KPIS,
      mr_attribution_pct: 99.1,
      commit_attribution_pct: 96.4,
    })
    assert.equal(read.material, false)
    assert.equal(read.level, 'ok')
  })

  it('calls a large gap bad rather than merely worth mentioning', () => {
    const read = readAttribution({ ...KPIS, mr_attribution_pct: 53.7 })
    assert.equal(read.level, 'bad')
  })
})

// --- sync ---------------------------------------------------------------------

const HOUR = 3_600_000
const NOW = Date.parse('2026-07-30T12:00:00Z')

function run(over: Partial<SyncRunFacts> & { source: string; status: string }): SyncRunFacts {
  return { started_at: '2026-07-30T11:00:00Z', finished_at: '2026-07-30T11:05:00Z', ...over }
}

function forSource(health: SourceHealth[], source: string): SourceHealth {
  const found = health.find((h) => h.source === source)
  assert.ok(found, `expected health for ${source}`)
  return found
}

describe('readSourceHealth', () => {
  it('says nothing about a source with no finished run, rather than calling it healthy', () => {
    // Started four minutes ago, so it is genuinely in flight rather than abandoned —
    // the distinction STALE_RUN_AFTER_MS draws, and the reason this run is dated
    // relative to NOW rather than using the hour-old default.
    const health = readSourceHealth(
      [run({ source: 'gitlab', status: 'running', started_at: '2026-07-30T11:56:00Z' })],
      NOW,
    )
    const gitlab = forSource(health, 'gitlab')
    assert.equal(gitlab.observed, false)
    assert.equal(gitlab.running, true)
    assert.equal(gitlab.abandonedRuns, 0)
    assert.equal(gitlab.level, 'unknown')
    assert.deepEqual(gitlab.alerts, [])
  })

  it('reports a failed last run and stops there', () => {
    const health = readSourceHealth(
      [
        run({ source: 'jira', status: 'error', started_at: '2026-07-30T11:30:00Z' }),
        run({ source: 'jira', status: 'partial', started_at: '2026-07-30T11:20:00Z' }),
        run({ source: 'jira', status: 'partial', started_at: '2026-07-30T11:10:00Z' }),
        run({ source: 'jira', status: 'partial', started_at: '2026-07-30T11:00:00Z' }),
      ],
      NOW,
    )
    const jira = forSource(health, 'jira')
    assert.equal(jira.level, 'bad')
    assert.deepEqual(jira.alerts, [
      { source: 'jira', level: 'bad', message: 'the last run failed' },
    ])
  })

  it('measures staleness from the last success, and escalates past three days', () => {
    const stale = readSourceHealth(
      [
        run({
          source: 'hibob',
          status: 'success',
          started_at: '2026-07-28T20:00:00Z',
          finished_at: new Date(NOW - 40 * HOUR).toISOString(),
        }),
      ],
      NOW,
    )
    assert.deepEqual(forSource(stale, 'hibob').alerts, [
      { source: 'hibob', level: 'warn', message: 'last completed 40 hours ago' },
    ])

    const ancient = readSourceHealth(
      [
        run({
          source: 'hibob',
          status: 'success',
          started_at: '2026-07-20T20:00:00Z',
          finished_at: new Date(NOW - 100 * HOUR).toISOString(),
        }),
      ],
      NOW,
    )
    assert.equal(forSource(ancient, 'hibob').alerts[0].level, 'bad')
  })

  it('flags a backfill that keeps stopping early even while data arrives', () => {
    const health = readSourceHealth(
      [
        run({ source: 'jira', status: 'partial', started_at: '2026-07-30T11:40:00Z' }),
        run({ source: 'jira', status: 'partial', started_at: '2026-07-30T11:30:00Z' }),
        run({ source: 'jira', status: 'partial', started_at: '2026-07-30T11:20:00Z' }),
        run({
          source: 'jira',
          status: 'success',
          started_at: '2026-07-30T11:10:00Z',
          finished_at: new Date(NOW - 1 * HOUR).toISOString(),
        }),
      ],
      NOW,
    )
    const jira = forSource(health, 'jira')
    assert.equal(jira.consecutivePartial, 3)
    assert.deepEqual(jira.alerts, [
      {
        source: 'jira',
        level: 'warn',
        message: '3 runs in a row stopped early — the backfill may not be advancing',
      },
    ])
  })

  it('reports a source that has finished runs but has never succeeded', () => {
    const health = readSourceHealth(
      [
        run({ source: 'gitlab', status: 'partial', started_at: '2026-07-30T11:20:00Z' }),
        run({ source: 'gitlab', status: 'partial', started_at: '2026-07-30T11:10:00Z' }),
      ],
      NOW,
    )
    const gitlab = forSource(health, 'gitlab')
    assert.equal(gitlab.hoursSinceSuccess, null)
    assert.equal(gitlab.level, 'bad')
    assert.equal(
      gitlab.alerts[0].message,
      'no run has completed yet — 2 attempts stopped early',
    )
  })

  it('counts a combined run towards every source it covers', () => {
    const health = readSourceHealth(
      [
        run({
          source: 'all',
          status: 'success',
          finished_at: new Date(NOW - 2 * HOUR).toISOString(),
        }),
      ],
      NOW,
    )
    for (const source of ['gitlab', 'jira', 'hibob']) {
      assert.equal(forSource(health, source).level, 'ok')
    }
  })

  it('orders the sources the same way whatever order the runs arrive in', () => {
    const runs = [
      run({ source: 'hibob', status: 'success', finished_at: new Date(NOW - HOUR).toISOString() }),
      run({ source: 'gitlab', status: 'success', finished_at: new Date(NOW - HOUR).toISOString() }),
    ]
    assert.deepEqual(
      readSourceHealth(runs, NOW).map((h) => h.source),
      ['gitlab', 'jira', 'hibob'],
    )
  })
})

// --- withholdings -------------------------------------------------------------

describe('orgWithholdings', () => {
  it('reads withheld off the value, not off re-applying the floor', () => {
    // Coverage below the floor, but the RPC returned a number anyway. The page has to
    // say "reported", because it is on the other pages whether we approve or not.
    const rows = orgWithholdings({ ...KPIS, deploy_coverage_pct: 20 })
    const deploys = rows.find((r) => r.metric === 'Deploy frequency')
    assert.ok(deploys)
    assert.equal(deploys.withheld, false)
  })

  it('reports story points as withheld on this org’s real coverage', () => {
    const points = orgWithholdings(KPIS).find((r) => r.metric === 'Story points')
    assert.ok(points)
    assert.equal(points.withheld, true)
    assert.deepEqual(points.guard, {
      kind: 'coverage',
      pct: 9.2,
      floor: 50,
      of: 'of resolved issues carry an estimate',
    })
  })

  it('carries an unknown coverage through as null rather than as zero', () => {
    const rows = orgWithholdings({ ...KPIS, deploy_coverage_pct: null })
    const guard = rows.find((r) => r.metric === 'Change failure rate')?.guard
    assert.ok(guard && guard.kind === 'coverage')
    assert.equal(guard.pct, null)
  })
})

// --- cohorts and the verdict --------------------------------------------------

function outlier(over: Partial<EngineerOutlier>): EngineerOutlier {
  return {
    engineer_id: 'e1',
    full_name: 'Someone',
    job_title: null,
    seniority_key: 'senior',
    seniority_label: 'Senior Engineer',
    peers_at_level: 9,
    squad_id: null,
    squad_key: null,
    squad_name: null,
    score: 50,
    rank_in_org: 1,
    rank_at_level: 1,
    score_confidence: 'high',
    confidence_reason: null,
    throughput_score: 50,
    flow_score: 50,
    quality_score: 50,
    collaboration_score: 50,
    signals_above: 0,
    signals_below: 0,
    signals_read: 3,
    net: 0,
    standing: 'typical',
    flow_band: 'typical',
    quality_band: 'typical',
    collaboration_band: 'typical',
    shape: 'Anchor',
    merged_mrs: 40,
    issues_resolved: 30,
    reviews_given: 60,
    distinct_authors_reviewed: 8,
    median_cycle_hours: 17,
    review_coverage_received_pct: 100,
    large_mr_pct: 10,
    reverts_authored: 0,
    last_active_at: null,
    effective_mrs: 40,
    points_per_mr: 1,
    median_churn: 100,
    trivial_mr_pct: 5,
    sized_mr_pct: 100,
    org_sized_mr_pct: 100,
    throughput_basis: 'complexity',
    // Tenure (0028). The fixture engineer is full-window on purpose: that is the
    // shape almost every row has, and it is the shape whose score must not have
    // moved. Presence cases are exercised in `tenure.test.ts`.
    start_date: '2021-01-01',
    days_in_window: 90,
    days_present: 90,
    presence_pct: 100,
    in_cohort_median: true,
    cohort_scored_peers: 9,
    throughput_units_prorated: 40,
    issues_resolved_prorated: 30,
    reviews_given_prorated: 60,
    reverts_authored_prorated: 0,
    ...over,
  }
}

describe('readScored', () => {
  it('marks a level below three as having no median', () => {
    const staff = {
      seniority_key: 'staff',
      seniority_label: 'Staff',
      peers_at_level: 2,
      cohort_scored_peers: 2,
      score_confidence: 'no_cohort' as const,
    }
    const read = readScored([
      outlier({ engineer_id: 'a', ...staff }),
      outlier({ engineer_id: 'b', ...staff }),
    ])
    assert.equal(read.cohorts.length, 1)
    assert.equal(read.cohorts[0].hasMedian, false)
    assert.equal(read.cohorts[0].noCohort, 2)
  })

  /**
   * The guard counts the people who actually defined the median, not the people at
   * the level. Three seniors of whom one joined last week is a median over two, and
   * a row saying "has a median: yes" there would be the exact reassurance 0028 was
   * written to remove.
   */
  it('counts the median on the peers who cleared the tenure floor, not on headcount', () => {
    const read = readScored([
      outlier({ engineer_id: 'a', peers_at_level: 3, cohort_scored_peers: 2 }),
      outlier({ engineer_id: 'b', peers_at_level: 3, cohort_scored_peers: 2 }),
      outlier({
        engineer_id: 'c',
        peers_at_level: 3,
        cohort_scored_peers: 2,
        in_cohort_median: false,
        days_present: 11,
        presence_pct: 12.2,
        score_confidence: 'partial_window',
        confidence_reason: 'Present for 11 of 90 days in this period',
      }),
    ])
    assert.equal(read.cohorts.length, 1)
    assert.equal(read.cohorts[0].people, 3)
    assert.equal(read.cohorts[0].scoredPeople, 2)
    assert.equal(read.cohorts[0].hasMedian, false)
    assert.equal(read.cohorts[0].partialWindow, 1)
    assert.equal(read.byConfidence.partial_window, 1)
  })

  it('takes the throughput basis off the rows rather than deciding it again', () => {
    const read = readScored([outlier({ throughput_basis: 'count', org_sized_mr_pct: 12.5 })])
    assert.equal(read.throughputBasis, 'count')
    assert.equal(read.orgSizedMrPct, 12.5)
  })

  it('reports an unknown sizing coverage as unknown', () => {
    const read = readScored([outlier({ org_sized_mr_pct: null })])
    assert.equal(read.orgSizedMrPct, null)
  })

  it('has no basis at all when nobody is scored', () => {
    const read = readScored([])
    assert.equal(read.throughputBasis, null)
    assert.equal(read.total, 0)
  })
})

describe('readVerdict', () => {
  const healthy = readSourceHealth(
    [
      run({
        source: 'all',
        status: 'success',
        finished_at: new Date(NOW - HOUR).toISOString(),
      }),
    ],
    NOW,
  )

  it('clears a day with nothing wrong, and does not count the denominator against it', () => {
    const verdict = readVerdict({
      attribution: readAttribution({
        ...KPIS,
        mr_attribution_pct: 99.5,
        commit_attribution_pct: 99.1,
      }),
      sources: healthy,
      withholdings: [],
      scored: readScored([outlier({})]),
      people: { directory: 45, inMetrics: 14 },
    })
    assert.equal(verdict.level, 'clear')
    assert.deepEqual(verdict.clauses, [])
    // Always true, so it belongs in notes: a verdict that always carries a caveat
    // is a verdict nobody reads.
    assert.equal(verdict.notes.length, 1)
    assert.equal(verdict.notes[0].section, 'people')
  })

  it('blocks on a broken source and names it first', () => {
    const verdict = readVerdict({
      attribution: readAttribution(KPIS),
      sources: readSourceHealth([run({ source: 'gitlab', status: 'error' })], NOW),
      withholdings: orgWithholdings(KPIS),
      scored: readScored([outlier({})]),
      people: { directory: 45, inMetrics: 14 },
    })
    assert.equal(verdict.level, 'blocked')
    assert.match(verdict.headline, /^Do not quote/)
    assert.equal(verdict.clauses[0].section, 'freshness')
    assert.match(verdict.clauses[0].text, /gitlab/)
  })

  it('caveats a day that is merely behind, and counts the caveats', () => {
    const verdict = readVerdict({
      attribution: readAttribution(KPIS),
      sources: readSourceHealth(
        [
          run({
            source: 'all',
            status: 'success',
            finished_at: new Date(NOW - 40 * HOUR).toISOString(),
          }),
        ],
        NOW,
      ),
      withholdings: orgWithholdings(KPIS),
      scored: readScored([outlier({ score_confidence: 'thin' })]),
      people: { directory: 45, inMetrics: 14 },
    })
    assert.equal(verdict.level, 'caveated')
    assert.match(verdict.headline, /^Quotable with \d+ caveats/)
    assert.ok(verdict.clauses.some((c) => c.section === 'coverage'))
    assert.ok(verdict.clauses.some((c) => c.section === 'withheld'))
    assert.ok(verdict.clauses.some((c) => c.section === 'cohorts'))
  })

  it('says an unmeasured attribution figure is unknown instead of leaving it out', () => {
    const verdict = readVerdict({
      attribution: readAttribution({
        ...KPIS,
        mr_attribution_pct: null,
        commit_attribution_pct: null,
      }),
      sources: healthy,
      withholdings: [],
      scored: readScored([outlier({})]),
      people: { directory: 14, inMetrics: 14 },
    })
    const clause = verdict.clauses.find((c) => c.section === 'coverage')
    assert.ok(clause)
    assert.equal(clause.level, 'unknown')
    assert.match(clause.text, /unknown/)
  })
})

// --- runs that never reported a result ----------------------------------------

/**
 * The state-machine fact this section pins: `running` is a claim with a shelf life.
 *
 * Production held four gitlab rows saying `running` for three days, and reading them
 * as "a run is in flight" is what let a scheduler that had stopped firing altogether
 * present as a sync mid-work. A row cannot be believed past the longest invocation
 * that could have written it.
 */
describe('readSourceHealth, on runs that never reported a result', () => {
  it('stops calling a long-open run in flight and raises it as bad', () => {
    const health = readSourceHealth(
      [
        run({ source: 'gitlab', status: 'running', started_at: '2026-07-27T22:43:00Z' }),
        run({
          source: 'gitlab',
          status: 'success',
          started_at: '2026-07-27T22:37:00Z',
          finished_at: '2026-07-27T22:43:00Z',
        }),
      ],
      NOW,
    )
    const gitlab = forSource(health, 'gitlab')
    assert.equal(gitlab.running, false)
    assert.equal(gitlab.abandonedRuns, 1)
    assert.equal(gitlab.oldestAbandonedAt, '2026-07-27T22:43:00Z')
    assert.equal(gitlab.level, 'bad')
    assert.ok(gitlab.alerts.some((a) => /never reported a result/.test(a.message)))
  })

  it('counts several and dates the oldest, which is how long nothing has been running', () => {
    const health = readSourceHealth(
      [
        run({ source: 'gitlab', status: 'running', started_at: '2026-07-27T22:43:00Z' }),
        run({ source: 'gitlab', status: 'running', started_at: '2026-07-27T19:30:00Z' }),
        run({ source: 'gitlab', status: 'running', started_at: '2026-07-27T16:26:00Z' }),
      ],
      NOW,
    )
    const gitlab = forSource(health, 'gitlab')
    assert.equal(gitlab.abandonedRuns, 3)
    assert.equal(gitlab.oldestAbandonedAt, '2026-07-27T16:26:00Z')
    assert.match(gitlab.alerts[0].message, /3 runs never reported a result/)
    // Still unobserved — no run of this source has ever finished — but the level is
    // bad, because three dead rows is a statement in itself.
    assert.equal(gitlab.observed, false)
    assert.equal(gitlab.level, 'bad')
  })

  it('keeps a genuinely slow run in flight, so a live sync is never libelled', () => {
    const health = readSourceHealth(
      [run({ source: 'jira', status: 'running', started_at: '2026-07-30T11:45:00Z' })],
      NOW,
    )
    const jira = forSource(health, 'jira')
    assert.equal(jira.running, true)
    assert.equal(jira.abandonedRuns, 0)
    assert.deepEqual(jira.alerts, [])
  })

  it('reports an abandoned run alongside a failed one rather than instead of it', () => {
    const health = readSourceHealth(
      [
        run({ source: 'hibob', status: 'running', started_at: '2026-07-27T16:26:00Z' }),
        run({ source: 'hibob', status: 'error', started_at: '2026-07-30T11:00:00Z' }),
      ],
      NOW,
    )
    const hibob = forSource(health, 'hibob')
    assert.equal(hibob.abandonedRuns, 1)
    assert.equal(hibob.alerts.length, 2)
    assert.equal(hibob.alerts[0].message, 'the last run failed')
    assert.match(hibob.alerts[1].message, /never reported a result/)
  })
})

// --- how deep the collection goes ---------------------------------------------

/**
 * The gap that looks like a finding.
 *
 * On 2026-07-31 the GitLab backward walk had reached 2026-04-29 and stopped, so the
 * 12-month selector served three months of merge-request history under a twelve-month
 * label — and the missing nine months read as months when the team shipped less. These
 * cases pin the arithmetic that says so, and the two things it must refuse to do:
 * treat an unmeasured depth as covered, and treat "the backfill finished" as covering
 * whatever period the reader happened to select.
 */
const WINDOW_NOW = Date.parse('2026-07-31T00:00:00Z')

function frontier(over: Partial<StreamFrontier> = {}): StreamFrontier {
  return {
    label: 'Merge requests',
    source: 'gitlab',
    reachedBackTo: '2026-04-29T06:32:51.940Z',
    complete: false,
    configuredWindowStart: '2025-07-31T00:00:00Z',
    earliestRecordAt: '2021-04-09T00:00:00Z',
    rowsInWindow: 1472,
    consequence: 'Throughput is counted over a shorter span than the period claims.',
    ...over,
  }
}

function windowOf(days: number) {
  return { from: new Date(WINDOW_NOW - days * 86_400_000), to: new Date(WINDOW_NOW) }
}

describe('readWindowCoverage', () => {
  it('calls the 90-day window covered, because the walk reached past its start', () => {
    const [mrs] = readWindowCoverage([frontier()], windowOf(90), WINDOW_NOW)
    assert.equal(mrs.coveredPct, 100)
    assert.equal(mrs.level, 'ok')
  })

  it('calls the 12-month window a quarter collected, which is what production held', () => {
    const [mrs] = readWindowCoverage([frontier()], windowOf(365), WINDOW_NOW)
    assert.ok(mrs.coveredPct !== null)
    // 2026-04-29 to 2026-07-31 is 93 days of a 365-day window.
    assert.equal(mrs.coveredDays, 93)
    assert.equal(mrs.windowDays, 365)
    assert.equal(Math.round(mrs.coveredPct), 25)
    assert.equal(mrs.level, 'bad')
  })

  it('is unknown, not zero, for a stream nothing has walked backwards', () => {
    const [mrs] = readWindowCoverage([frontier({ reachedBackTo: null })], windowOf(365), WINDOW_NOW)
    assert.equal(mrs.coveredPct, null)
    assert.equal(mrs.coveredDays, null)
    assert.equal(mrs.level, 'unknown')
  })

  it('does not let an old row stand in for depth the walk never reached', () => {
    // The oldest row held is 2021, five years deep, and it changes nothing: it arrived
    // through the forward walk's updated-at window, not because 2021 was collected.
    const [mrs] = readWindowCoverage(
      [frontier({ earliestRecordAt: '2021-04-09T00:00:00Z' })],
      windowOf(365),
      WINDOW_NOW,
    )
    assert.equal(Math.round(mrs.coveredPct!), 25)
  })

  it('reads a finished backfill as covering its configured window, and no further', () => {
    const complete = frontier({ complete: true, reachedBackTo: null })
    assert.equal(readWindowCoverage([complete], windowOf(365), WINDOW_NOW)[0].coveredPct, 100)

    // Two years of window against a twelve-month backfill is half collected, however
    // finished that backfill is. Taking 'complete' to mean 100% would put the
    // assumption back in a new place.
    const twoYears = readWindowCoverage([complete], windowOf(730), WINDOW_NOW)[0]
    assert.equal(Math.round(twoYears.coveredPct!), 50)
    assert.equal(twoYears.level, 'bad')
  })

  it('measures each stream separately, because the walks do not travel together', () => {
    const rows = readWindowCoverage(
      [
        frontier({ label: 'Merge requests', reachedBackTo: '2026-04-29T06:32:51.940Z' }),
        frontier({ label: 'Production deployments', reachedBackTo: '2026-06-10T09:09:57.475Z' }),
      ],
      windowOf(365),
      WINDOW_NOW,
    )
    assert.equal(Math.round(rows[0].coveredPct!), 25)
    assert.equal(Math.round(rows[1].coveredPct!), 14)
    assert.ok(rows[1].coveredPct! < rows[0].coveredPct!)
  })
})

describe('readCron', () => {
  it('calls an unset secret bad, because nothing will refresh without it', () => {
    assert.equal(readCron({ configured: false, missing: ['CRON_SECRET'], schedules: [] }).level, 'bad')
  })

  it('calls a configured secret ok', () => {
    assert.equal(readCron({ configured: true, missing: [], schedules: [] }).level, 'ok')
  })
})

describe('readVerdict, on collection depth and the scheduler', () => {
  const healthy = readSourceHealth(
    [run({ source: 'all', status: 'success', finished_at: new Date(NOW - HOUR).toISOString() })],
    NOW,
  )
  const base = {
    attribution: readAttribution({
      ...KPIS,
      mr_attribution_pct: 99.5,
      commit_attribution_pct: 99.1,
    }),
    sources: healthy,
    withholdings: [],
    scored: readScored([outlier({})]),
    people: { directory: 14, inMetrics: 14 },
  }

  it('blocks on a short window and says which view is short', () => {
    const verdict = readVerdict({
      ...base,
      windows: {
        label: 'Last 12 months',
        coverage: readWindowCoverage([frontier()], windowOf(365), WINDOW_NOW),
      },
    })
    assert.equal(verdict.level, 'blocked')
    const clause = verdict.clauses.find((c) => c.section === 'depth')
    assert.ok(clause)
    assert.match(clause.text, /Last 12 months/)
    assert.match(clause.text, /93 of 365 days/)
    assert.match(clause.text, /quiet ones/)
  })

  it('says nothing about depth for a window that was fully collected', () => {
    const verdict = readVerdict({
      ...base,
      windows: {
        label: 'Last 90 days',
        coverage: readWindowCoverage([frontier()], windowOf(90), WINDOW_NOW),
      },
    })
    assert.equal(verdict.clauses.filter((c) => c.section === 'depth').length, 0)
    assert.equal(verdict.level, 'clear')
  })

  it('stays silent on depth when no coverage was passed, rather than assuming it', () => {
    const verdict = readVerdict(base)
    assert.equal(verdict.clauses.filter((c) => c.section === 'depth').length, 0)
  })

  it('puts the unset cron secret ahead of the staleness it causes', () => {
    const stale = readSourceHealth(
      [
        run({
          source: 'all',
          status: 'success',
          started_at: new Date(NOW - 80 * HOUR).toISOString(),
          finished_at: new Date(NOW - 80 * HOUR).toISOString(),
        }),
      ],
      NOW,
    )
    const verdict = readVerdict({
      ...base,
      sources: stale,
      cron: readCron({
        configured: false,
        missing: ['CRON_SECRET'],
        schedules: [{ path: '/api/sync', schedule: '0 3 * * *', what: 'pulls everything' }],
      }),
    })
    assert.equal(verdict.level, 'blocked')
    // The cause, not the symptom, is what the headline quotes.
    assert.match(verdict.clauses[0].text, /cannot authenticate/)
    assert.match(verdict.clauses[0].text, /CRON_SECRET/)
    assert.match(verdict.headline, /cannot authenticate/)
    // And the staleness it produces is still listed underneath it.
    assert.ok(verdict.clauses.slice(1).some((c) => /hours ago/.test(c.text)))
  })

  it('says nothing about the scheduler when its secret is set', () => {
    const verdict = readVerdict({
      ...base,
      cron: readCron({ configured: true, missing: [], schedules: [] }),
    })
    assert.equal(verdict.level, 'clear')
  })
})
