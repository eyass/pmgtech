import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  asIsoDate,
  classifyBridgeCandidate,
  dedupeByConflictKey,
  hasLeft,
  isMachineEmail,
  isPersonalBoard,
  isProductionEnvironment,
  isUnroutableEmail,
  sharesNameToken,
  type BridgeCandidate,
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

describe('isMachineEmail', () => {
  it('recognises the service accounts this instance actually has', () => {
    for (const email of [
      'service_account_group_7262254_e2b1e9c5904b06564b373586ff54bd31@noreply.gitlab.com',
      'project_17130281_bot_c65dc431a1c21ae86602690495015461@noreply.gitlab.com',
      'ci@petmediagroup.com',
      'gitlab-ci@petmediagroup.com',
    ]) {
      assert.equal(isMachineEmail(email), true, email)
    }
  })

  it('leaves the addresses people actually commit under alone', () => {
    for (const email of [
      'norbert@petmediagroup.com',
      'marcin.niemirski@petmediagroup.com',
      'eyass@hastnet.se',
      'jacek@petmediagroup.com',
    ]) {
      assert.equal(isMachineEmail(email), false, email)
    }
  })

  it('does not call a person a bot for a local git config', () => {
    // Norbert Hires commits as norberthires@norberts-macbook-air.local. Excluding him as
    // a bot would delete a real person's work — the exact failure this codebase exists
    // to stop — so an unroutable address is a separate verdict.
    assert.equal(isMachineEmail('norberthires@norberts-macbook-air.local'), false)
    assert.equal(isUnroutableEmail('norberthires@norberts-macbook-air.local'), true)
  })

  it('does not reject a person whose name merely contains "bot"', () => {
    assert.equal(isMachineEmail('abbot@petmediagroup.com'), false)
    assert.equal(isMachineEmail('botond@petmediagroup.com'), false)
  })

  it('treats a real domain as routable', () => {
    assert.equal(isUnroutableEmail('norbert@petmediagroup.com'), false)
    assert.equal(isUnroutableEmail('someone@localhost'), true)
    assert.equal(isUnroutableEmail('no-at-sign'), true)
  })
})

describe('sharesNameToken', () => {
  it('matches across a diminutive when the surname agrees', () => {
    // The real pair: GitLab says "Manolis Kypriotakis", HiBob says "Emmanouil Kypriotakis".
    assert.equal(sharesNameToken('Manolis Kypriotakis', 'Emmanouil Kypriotakis'), true)
  })

  it('matches through diacritics', () => {
    assert.equal(sharesNameToken('Jacek Kadłuczka', 'Jacek Kadluczka'), true)
    assert.equal(sharesNameToken('Sørensen', 'Sorensen'), true)
  })

  it('does not match two different people', () => {
    // The case that makes the corroboration check worth having: this account's commits
    // are 63% authored by an unrelated person's address.
    assert.equal(sharesNameToken('Daria Melnyk', 'Eyass Shakrah'), false)
  })

  it('ignores initials and short tokens rather than matching on them', () => {
    assert.equal(sharesNameToken('J. Smith', 'J. Brown'), false)
    assert.equal(sharesNameToken('Al Fox', 'Al Wolf'), false)
  })

  it('is false when either name is missing', () => {
    assert.equal(sharesNameToken(null, 'Norbert Sajdok'), false)
    assert.equal(sharesNameToken('Norbert Sajdok', ''), false)
  })
})

describe('classifyBridgeCandidate', () => {
  const base: BridgeCandidate = {
    provider: 'gitlab',
    externalId: '1',
    displayName: 'Norbert Sajdok',
    handle: 'nsajdok',
    email: 'norbert@petmediagroup.com',
    mrsWon: 181,
    mrs: 205,
    engineerId: 'eng-norbert',
    engineerName: 'Norbert Sajdok',
  }

  it('links the unambiguous cases from this instance', () => {
    const cases: [Partial<BridgeCandidate>, string][] = [
      [{}, 'nsajdok 88.3%'],
      [{ mrsWon: 62, mrs: 70, displayName: 'Jacek Kadłuczka', engineerName: 'Jacek Kadłuczka' }, 'jacek 88.6%'],
      [{ mrsWon: 59, mrs: 61, displayName: 'Dariusz Litawor', engineerName: 'Dariusz Litawor' }, 'dariusz 96.7%'],
      [
        { mrsWon: 31, mrs: 31, displayName: 'Manolis Kypriotakis', engineerName: 'Emmanouil Kypriotakis' },
        'manolis 100%',
      ],
    ]
    for (const [patch, label] of cases) {
      const verdict = classifyBridgeCandidate({ ...base, ...patch })
      assert.equal(verdict.action, 'link', label)
    }
  })

  it('holds back the 58% case for review even though the names match', () => {
    // marcin.niemirski.pmg — right person, but his merge requests carry enough of other
    // people's commits that the evidence should not be acted on unattended.
    const verdict = classifyBridgeCandidate({
      ...base,
      displayName: 'Marcin Niemirski',
      engineerName: 'Marcin Niemirski',
      email: 'marcin.niemirski@petmediagroup.com',
      mrsWon: 63,
      mrs: 108,
    })
    assert.equal(verdict.action, 'suggest-link')
    assert.equal(verdict.action === 'suggest-link' && verdict.confidence, 58.3)
  })

  it('refuses to link when the names disagree, however dominant the email', () => {
    const verdict = classifyBridgeCandidate({
      ...base,
      displayName: 'Daria Melnyk',
      email: 'eyass@hastnet.se',
      engineerId: 'eng-eyass',
      engineerName: 'Eyass Shakrah',
      mrsWon: 20,
      mrs: 20,
    })
    assert.equal(verdict.action, 'suggest-link')
  })

  it('calls the CI account a bot rather than a person', () => {
    // 325 merge requests, 96% dominance — the strongest evidence in the data, and wrong.
    const verdict = classifyBridgeCandidate({
      ...base,
      displayName: 'PMG CI bot',
      handle: 'pmg-ci-bot',
      email: 'service_account_group_7262254_e2b1e9c5904b06564b373586ff54bd31@noreply.gitlab.com',
      engineerId: null,
      engineerName: null,
      mrsWon: 313,
      mrs: 325,
    })
    assert.equal(verdict.action, 'suggest-bot')
  })

  it('suggests creating an engineer for a real address with no record', () => {
    const verdict = classifyBridgeCandidate({
      ...base,
      displayName: 'Torsten Malcherczyk',
      email: 'torsten@petmediagroup.com',
      engineerId: null,
      engineerName: null,
      mrsWon: 9,
      mrs: 9,
    })
    assert.equal(verdict.action, 'suggest-engineer')
  })

  it('asks a human about a real person committing from a local git config', () => {
    const verdict = classifyBridgeCandidate({
      ...base,
      displayName: 'Norbert Hires',
      handle: 'norbert.h',
      email: 'norberthires@norberts-macbook-air.local',
      engineerId: null,
      engineerName: null,
      mrsWon: 9,
      mrs: 10,
    })
    assert.equal(verdict.action, 'suggest-manual')
  })

  it('skips an account with too little history to judge', () => {
    const verdict = classifyBridgeCandidate({ ...base, mrsWon: 2, mrs: 2 })
    assert.equal(verdict.action, 'skip')
  })

  it('does not divide by zero when an account has no commits at all', () => {
    const verdict = classifyBridgeCandidate({ ...base, mrsWon: 0, mrs: 0 })
    assert.equal(verdict.action, 'skip')
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
