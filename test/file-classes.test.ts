import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyFile, moduleOf, shapeOfChange } from '../src/lib/sync/file-classes.ts'

/**
 * The point of these rules is that a dependency bump must not read as five
 * thousand lines of work. That is the same gaming the complexity weight exists to
 * stop, arriving from the opposite direction — and unlike a wrong line count, a
 * path pattern that stops matching fails silently.
 */
describe('classifyFile', () => {
  it('recognises the lockfiles and build output nobody hand-wrote', () => {
    for (const path of [
      'package-lock.json',
      'apps/web/yarn.lock',
      'pnpm-lock.yaml',
      'go.sum',
      'Cargo.lock',
      'dist/main.js',
      'apps/web/.next/static/chunk.js',
      'vendor/github.com/pkg/errors/errors.go',
      'src/__snapshots__/Button.test.tsx.snap',
      'public/app.min.js',
      'api/service.pb.go',
      'src/generated/schema.ts',
      'src/types.generated.ts',
      'coverage/lcov.info',
    ]) {
      assert.equal(classifyFile(path), 'generated', `${path} should be generated`)
    }
  })

  it('separates tests from source', () => {
    for (const path of [
      'test/matching.test.ts',
      'src/lib/sync/change-size.test.ts',
      'spec/models/user_spec.rb',
      '__tests__/helpers.js',
      'internal/server/server_test.go',
      'e2e/checkout.ts',
    ]) {
      assert.equal(classifyFile(path), 'test', `${path} should be test`)
    }
    assert.equal(classifyFile('src/lib/queries.ts'), 'source')
    assert.equal(classifyFile('src/app/outliers/page.tsx'), 'source')
  })

  it('puts generated ahead of test, because a generated snapshot is not written work', () => {
    assert.equal(classifyFile('src/__snapshots__/a.test.ts.snap'), 'generated')
  })

  it('puts test ahead of config, so a fixture in a test directory counts as test work', () => {
    assert.equal(classifyFile('test/fixtures/payload.json'), 'test')
    assert.equal(classifyFile('tsconfig.json'), 'config')
  })

  it('classifies docs, config and assets', () => {
    assert.equal(classifyFile('README.md'), 'docs')
    assert.equal(classifyFile('docs/measurement-framework.md'), 'docs')
    assert.equal(classifyFile('Dockerfile'), 'config')
    assert.equal(classifyFile('.eslintrc'), 'config')
    assert.equal(classifyFile('public/logo.svg'), 'asset')
  })
})

describe('moduleOf', () => {
  it('groups by directory rather than by file', () => {
    assert.equal(moduleOf('src/lib/sync/gitlab.ts'), 'src/lib')
    assert.equal(moduleOf('src/app/page.tsx'), 'src/app')
    assert.equal(moduleOf('README.md'), '.')
  })
})

describe('shapeOfChange', () => {
  it('keeps a lockfile bump out of authored churn', () => {
    const shape = shapeOfChange([
      { path: 'package-lock.json', additions: 4800, deletions: 200 },
      { path: 'package.json', additions: 2, deletions: 2 },
    ])
    assert.equal(shape.churnTotal, 5004)
    // The number the weight should use: four lines, not five thousand.
    assert.equal(shape.churnAuthored, 4)
    assert.equal(shape.generatedPct, 99.9)
    assert.equal(shape.filesAuthored, 1)
  })

  it('measures breadth by directory, not by file count', () => {
    const shape = shapeOfChange([
      { path: 'src/lib/a.ts', additions: 10, deletions: 0 },
      { path: 'src/lib/b.ts', additions: 10, deletions: 0 },
      { path: 'src/lib/c.ts', additions: 10, deletions: 0 },
      { path: 'src/app/d.tsx', additions: 10, deletions: 0 },
    ])
    assert.equal(shape.filesAuthored, 4)
    assert.equal(shape.modules, 2)
  })

  it('reports the test-to-source ratio without scoring it', () => {
    const withTests = shapeOfChange([
      { path: 'src/lib/x.ts', additions: 100, deletions: 0 },
      { path: 'test/x.test.ts', additions: 50, deletions: 0 },
    ])
    assert.equal(withTests.churnSource, 100)
    assert.equal(withTests.churnTest, 50)
    assert.equal(withTests.testRatio, 0.5)

    // No source touched at all: a ratio would be a division by zero dressed up as
    // a finding, so it stays null.
    const docsOnly = shapeOfChange([{ path: 'README.md', additions: 10, deletions: 1 }])
    assert.equal(docsOnly.testRatio, null)
    assert.equal(docsOnly.churnAuthored, 11)
  })

  it('handles an empty change without inventing numbers', () => {
    const shape = shapeOfChange([])
    assert.equal(shape.churnTotal, 0)
    assert.equal(shape.churnAuthored, 0)
    assert.equal(shape.modules, 0)
    assert.equal(shape.generatedPct, 0)
    assert.equal(shape.testRatio, null)
  })
})
