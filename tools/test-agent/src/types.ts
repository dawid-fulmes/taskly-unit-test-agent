export type App = 'backend' | 'frontend'
export type Mode = 'pr' | 'backfill'
export type Outcome =
  | 'tests-added'
  | 'already-covered'
  | 'nothing-to-test'
  | 'draft'
  | 'config-changed'
  | 'budget-exhausted'
  | 'timeout'
  | 'patch-rejected'
  | 'verification-failed'
  | 'skip-unverified'
  | 'discovery-mismatch'
  | 'agent-run-invalid'
  | 'baseline-failing'
  | 'head-moved'
  | 'pipeline-error'
  | 'defect'
  | 'defect-dismissed'
export type Conclusion = 'success' | 'neutral' | 'failure'
export interface ManifestEntry {
  path: string
  app: App
  status: 'added' | 'modified' | 'renamed'
  changedLines: number[]
  excludedOnBase: boolean
}
export interface Plan {
  mode: Mode
  prNumber: number | null
  baseSha: string
  headSha: string
  title: string
  description: string
  draft: boolean
  earlyOutcome: 'draft' | 'config-changed' | 'nothing-to-test' | null
  manifest: ManifestEntry[]
  dependenciesChanged: boolean
  testsRemovedByAuthor: { file: string; count: number }[]
  budgetProfile: 'default' | 'large' | 'backfill'
  /** Existing test files on the analysed tree, a discovery aid for the agent (no decisions use it). */
  testFiles?: string[]
}
