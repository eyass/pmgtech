import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  asIsoDate,
  dedupeByConflictKey,
  hasLeft,
  isPersonalBoard,
  isProductionEnvironment,
} from '../src/lib/sync/matching.ts'

const PROD_PATTERNS = ['production', 'prod', 'live']

describe('isProductionEnvironment', () => {
  it('accepts real production environment names from this org', () => {
    for (const name of [
      'prod-client-lancasterpuppies',
      'p4h-prod-client-pets4homes',
      'prod-server-annuncianimali',
      'prod-grafana-alloy-pets4homes',
      'prod-lambdas-hastnet',
      'production',
      'live',
    ]) {
      assert.equal(isProductionEnvironment(name, PROD_PATTERNS), true, name)
    }
  })

  it('rejects nonprod, which a substring match wrongly accepted', () => {
    // The live bug: 16 nonprod-grafana-alloy-* environments were flagged production and
    // stayed out of the DORA numbers only because none had a terminal status yet.
    for (const name of [
      'nonprod-grafana-alloy-testing-pets4homes',
      'nonprod-grafana-alloy-testing-deinetierwelt',
      'non-prod-thing',
      'non_prod_thing',
    ]) {
      assert.equal(isProductionEnvironment(name, PROD_PATTERNS), false, name)
    }
  })

  it('rejects the non-production environments this org actually runs', () => {
    for (const name of [
      '-client-staging-pets4homes',
      '-client-qa-pets4homes',
      '-backend.module.migrator-testing-annuncianimali',
      '-listing-elastic-updater-qa-pets4homes',
      'e2e/mr-21247-web-p4h',
      '-proxy-api.module.proxy-api-qa-lancasterpuppies',
      '-sitemaps-staging-lancasterpuppies',
    ]) {
      assert.equal(isProductionEnvironment(name, PROD_PATTERNS), false, name)
    }
  })

  it('does not match a pattern buried mid-word', () => {
    assert.equal(isProductionEnvironment('reproduction-env', PROD_PATTERNS), false)
    assert.equal(isProductionEnvironment('unproductive', PROD_PATTERNS), false)
  })

  it('still matches when the pattern is followed by more letters', () => {
    assert.equal(isProductionEnvironment('production-eu', PROD_PATTERNS), true)
    assert.equal(isProductionEnvironment('prod2', PROD_PATTERNS), true)
  })

  it('finds a later occurrence when an earlier one is negated', () => {
    assert.equal(isProductionEnvironment('staging-nonprod-live-check', PROD_PATTERNS), true)
  })

  it('is case insensitive and tolerates empty patterns', () => {
    assert.equal(isProductionEnvironment('PROD-Client', PROD_PATTERNS), true)
    assert.equal(isProductionEnvironment('prod-x', ['']), false)
    assert.equal(isProductionEnvironment('prod-x', []), false)
  })
})

describe('asIsoDate', () => {
  it('accepts an ISO calendar date', () => {
    assert.equal(asIsoDate('2024-10-01'), '2024-10-01')
    assert.equal(asIsoDate('  2025-01-07  '), '2025-01-07')
  })

  it('rejects the locale-formatted dates HiBob returns with humanReadable REPLACE', () => {
    // Postgres rejected "20/07/2026" outright, which failed the whole sync. The
    // ambiguous ones matter more: "07/01/2025" is two different days by locale, so
    // guessing would put a wrong tenure on a profile.
    for (const raw of ['20/07/2026', '01/10/2024', '07/01/2025', '1/10/24']) {
      assert.equal(asIsoDate(raw), null, raw)
    }
  })

  it('rejects timestamps, empty values and nonsense', () => {
    for (const raw of ['2024-10-01T00:00:00Z', '', '   ', 'yesterday', null, undefined, {}]) {
      assert.equal(asIsoDate(raw), null, String(raw))
    }
  })

  it('rejects a well-formed but impossible date', () => {
    assert.equal(asIsoDate('2025-02-31'), null)
    assert.equal(asIsoDate('2025-13-01'), null)
  })
})

describe('hasLeft', () => {
  const now = new Date('2026-07-28T00:00:00.000Z')

  it('is false for a future termination date', () => {
    // A notice period is not a departure. Treating it as one dropped someone from
    // their squad's numbers weeks before they left.
    assert.equal(hasLeft('2026-09-01', now), false)
  })

  it('is true once the date has passed', () => {
    assert.equal(hasLeft('2026-06-01', now), true)
  })

  it('is false when there is no date', () => {
    assert.equal(hasLeft(null, now), false)
    assert.equal(hasLeft('', now), false)
    assert.equal(hasLeft(undefined, now), false)
  })

  it('is false for an unparseable value rather than assuming departure', () => {
    assert.equal(hasLeft('not a date', now), false)
  })
})

describe('dedupeByConflictKey', () => {
  it('keeps the last occurrence of a repeated key', () => {
    // The live failure: GitLab returned the same pipeline under two refs, and Postgres
    // refused with "ON CONFLICT DO UPDATE command cannot affect row a second time",
    // which took down the whole project sync — and with it all deployment data.
    const rows = [
      { gitlab_id: 1, status: 'running' },
      { gitlab_id: 2, status: 'success' },
      { gitlab_id: 1, status: 'success' },
    ]
    const out = dedupeByConflictKey(rows, 'gitlab_id')
    assert.equal(out.length, 2)
    assert.equal(out.find((r) => r.gitlab_id === 1)?.status, 'success', 'later row wins')
  })

  it('handles composite keys', () => {
    const rows = [
      { project_id: 'a', gitlab_id: 1, n: 1 },
      { project_id: 'b', gitlab_id: 1, n: 2 },
      { project_id: 'a', gitlab_id: 1, n: 3 },
    ]
    const out = dedupeByConflictKey(rows, 'project_id,gitlab_id')
    assert.equal(out.length, 2)
    assert.equal(out.find((r) => r.project_id === 'a')?.n, 3)
  })

  it('tolerates spacing in the conflict spec', () => {
    const rows = [
      { a: 1, b: 1 },
      { a: 1, b: 2 },
    ]
    assert.equal(dedupeByConflictKey(rows, ' a , b ').length, 2)
    assert.equal(dedupeByConflictKey(rows, 'a').length, 1)
  })

  it('treats a missing column as null rather than throwing', () => {
    const rows = [{ a: 1 }, {}, {}]
    assert.equal(dedupeByConflictKey(rows, 'a').length, 2)
  })

  it('returns everything when there is no conflict spec', () => {
    const rows = [{ a: 1 }, { a: 1 }]
    assert.equal(dedupeByConflictKey(rows, '').length, 2)
  })

  it('preserves order of first appearance', () => {
    const rows = [{ a: 3 }, { a: 1 }, { a: 2 }, { a: 1 }]
    assert.deepEqual(
      dedupeByConflictKey(rows, 'a').map((r) => r.a),
      [3, 1, 2],
    )
  })
})

describe('isPersonalBoard', () => {
  const patterns = ['personal board', "'s board"]

  it('matches the personal boards in this instance', () => {
    for (const name of ["Petra's personal board", "Mehmet's board", "Marek's board in Design"]) {
      assert.equal(isPersonalBoard(name, patterns), true, name)
    }
  })

  it('leaves team boards alone', () => {
    for (const name of [
      'BUY board',
      'SELL board',
      'DATA Scrum',
      'Tech Scrum board',
      'Product Design Board',
      'Agentic Board',
    ]) {
      assert.equal(isPersonalBoard(name, patterns), false, name)
    }
  })
})
