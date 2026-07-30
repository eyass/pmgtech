/**
 * Classifying the files in a change, so churn can be read for what it is.
 *
 * A line count on its own is a poor measure of a change, and it fails in one
 * specific, common way: generated files. A dependency bump rewrites
 * `package-lock.json` by five thousand lines and contains no engineering at all;
 * a build output committed to the repo does the same. Under a pure churn weight
 * both score the maximum, which hands anyone who notices an easy way to look
 * productive — the exact thing the complexity metric exists to prevent, arriving
 * from the opposite direction.
 *
 * This module is pure and import-free so it can be tested directly, for the same
 * reason `change-size.ts` is: the rules are the kind that fail silently. A path
 * pattern that stops matching does not throw, it just quietly starts counting
 * lockfiles as work.
 *
 * Requires per-file paths, which GitLab exposes through GraphQL
 * (`mergeRequest.diffStats { path additions deletions }`) without the diff bodies
 * the REST diff endpoints bundle in.
 */

export type FileClass = 'source' | 'test' | 'generated' | 'config' | 'docs' | 'asset'

export interface FileChange {
  path: string
  additions: number
  deletions: number
}

/**
 * Paths whose contents a person did not write line by line. Deliberately matched
 * on structure rather than a curated list of filenames, because the failure mode of
 * a list is that it silently goes out of date.
 */
const GENERATED = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/,
  /(^|\/)(dist|build|out|vendor|node_modules|target|\.next|coverage)\//,
  /(^|\/)__snapshots__\//,
  /\.(min\.js|min\.css|map|snap)$/,
  /\.(pb|pb2)\.(go|ts|js|py)$/,
  /(^|\/)generated\//,
  /\.generated\.[a-z]+$/,
]

const TEST = [
  /(^|\/)(test|tests|spec|__tests__|e2e|cypress)\//,
  /\.(test|spec)\.[a-z]+$/,
  /(^|\/)[A-Za-z0-9_]+_test\.[a-z]+$/,
]

const DOCS = [/\.(md|mdx|rst|txt|adoc)$/i, /(^|\/)(docs|documentation)\//]

const CONFIG = [
  /\.(json|ya?ml|toml|ini|env|conf|cfg|properties)$/i,
  /(^|\/)\.[a-z]+rc(\.[a-z]+)?$/,
  /(^|\/)(Dockerfile|Makefile|\.gitignore|\.dockerignore)$/,
]

const ASSET = [/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|pdf|csv)$/i]

/**
 * What kind of file is this? Order matters and encodes the precedence that makes
 * the classification useful: generated beats everything (a generated test file is
 * still not written work), and tests beat config and docs so that a YAML fixture
 * inside a test directory counts as test work rather than configuration.
 */
export function classifyFile(path: string): FileClass {
  if (GENERATED.some((re) => re.test(path))) return 'generated'
  if (TEST.some((re) => re.test(path))) return 'test'
  if (ASSET.some((re) => re.test(path))) return 'asset'
  if (DOCS.some((re) => re.test(path))) return 'docs'
  if (CONFIG.some((re) => re.test(path))) return 'config'
  return 'source'
}

/** The directory a change belongs to, for counting how far it is spread. */
export function moduleOf(path: string, depth = 2): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 1) return '.'
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/')
}

export interface ChangeShape {
  /** Every line in the change, generated files included. */
  churnTotal: number
  /**
   * Churn a person actually wrote: generated files excluded. This is what the
   * complexity weight should use — a 5,000-line lockfile diff is not five thousand
   * lines of work, and counting it as such is the easiest way to game a size metric.
   */
  churnAuthored: number
  /** Churn in source files only, excluding tests, config, docs and assets. */
  churnSource: number
  churnTest: number
  filesTotal: number
  filesAuthored: number
  /** Distinct directories touched — breadth that a file count alone overstates. */
  modules: number
  /** Share of authored churn that is generated. High means the diff is mostly noise. */
  generatedPct: number
  /**
   * Test churn over source churn. Not scored — reported. A change with substantial
   * source and no tests is a question, and one with tests is evidence the size was
   * real work rather than padding.
   */
  testRatio: number | null
}

/** Summarise a change's files into the shape a weight can be computed from. */
export function shapeOfChange(files: FileChange[]): ChangeShape {
  let churnTotal = 0
  let churnAuthored = 0
  let churnSource = 0
  let churnTest = 0
  let filesAuthored = 0
  let churnGenerated = 0
  const modules = new Set<string>()

  for (const file of files) {
    const churn = (file.additions ?? 0) + (file.deletions ?? 0)
    const kind = classifyFile(file.path)
    churnTotal += churn

    if (kind === 'generated') {
      churnGenerated += churn
      continue
    }

    churnAuthored += churn
    filesAuthored += 1
    modules.add(moduleOf(file.path))
    if (kind === 'source') churnSource += churn
    if (kind === 'test') churnTest += churn
  }

  return {
    churnTotal,
    churnAuthored,
    churnSource,
    churnTest,
    filesTotal: files.length,
    filesAuthored,
    modules: modules.size,
    generatedPct:
      churnTotal > 0 ? Math.round((1000 * churnGenerated) / churnTotal) / 10 : 0,
    testRatio: churnSource > 0 ? Math.round((100 * churnTest) / churnSource) / 100 : null,
  }
}
