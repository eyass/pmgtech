import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  groupEngineerOptions,
  shouldGroup,
  type EngineerOption,
} from '../src/lib/engineer-options.ts'

function make(n: number, flags: Partial<EngineerOption> = {}): EngineerOption[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${flags.ignored ? 'x' : flags.former ? 'f' : 'c'}${i}`,
    name: `Person ${i}`,
    ...flags,
  }))
}

test('offers every engineer in the directory, grouped by standing', () => {
  // The real shape of this org's directory when the picker was reported as broken.
  const engineers = [...make(20), ...make(10, { former: true }), ...make(15, { ignored: true })]
  const groups = groupEngineerOptions(engineers)

  assert.equal(groups.length, 3)
  assert.deepEqual(
    groups.map((g) => g.label),
    [
      'Currently employed (20)',
      'Former or added by hand (10)',
      'Ignored — linked work stays hidden (15)',
    ],
  )
  // Nobody is dropped: all 45 are reachable, which was the actual complaint.
  assert.equal(
    groups.reduce((sum, g) => sum + g.list.length, 0),
    45,
  )
})

test('counts are in the labels, so a buried group is still findable', () => {
  const groups = groupEngineerOptions([...make(20), ...make(10, { former: true })])
  // Without the count, twenty names above the leavers made the first group read as
  // the whole list. The number is the only hint a native select gives.
  assert.ok(groups[0]!.label.includes('(20)'))
  assert.ok(groups[1]!.label.includes('(10)'))
})

test('an ignored engineer is offered, and the label states what it costs', () => {
  const groups = groupEngineerOptions([...make(1), ...make(2, { ignored: true })])
  const ignored = groups.find((g) => g.list.some((e) => e.ignored))
  assert.ok(ignored, 'ignored engineers must be offered, not filtered away')
  assert.match(ignored.label, /stays hidden/)
})

test('an ignored engineer is never counted as current, even when also former', () => {
  const groups = groupEngineerOptions(make(3, { former: true, ignored: true }))
  assert.equal(groups.length, 1)
  assert.match(groups[0]!.label, /^Ignored/)
})

test('a single kind of engineer renders flat rather than under one heading', () => {
  assert.equal(shouldGroup(groupEngineerOptions(make(5))), false)
  assert.equal(shouldGroup(groupEngineerOptions(make(5, { former: true }))), false)
  assert.equal(shouldGroup(groupEngineerOptions([...make(1), ...make(1, { former: true })])), true)
})

test('an empty directory produces no groups', () => {
  assert.deepEqual(groupEngineerOptions([]), [])
  assert.equal(shouldGroup([]), false)
})
