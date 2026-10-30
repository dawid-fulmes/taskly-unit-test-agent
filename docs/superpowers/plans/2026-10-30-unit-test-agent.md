# Unit Test Agent and PR Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code test-writing agent with six skills, a deterministic verifier, and a GitHub pipeline that runs it on pull requests and in backfill mode, with every number and status on the PR computed by code rather than taken from the model.

**Architecture:** A TypeScript tooling package (`tools/test-agent/`) holds all deterministic logic as pure, unit-tested functions plus thin CLIs: policy, guard hook, runner, diff/gates, plan, coverage, results parsing, verdict, comment, publish, trigger filter. `.claude/` holds the agent, skills and explicit settings. GitHub Actions wires them as `trigger (pull_request, unprivileged) → workflow_run from main → plan → generate → verify → publish`, with backfill reusing the same pipeline.

**Tech Stack:** Node 22 (native TypeScript type stripping), Vitest 4, `picomatch`, `parse-diff`, `ajv`, `@octokit/rest`, `typescript` (compiler API for config parsing), Docker (`node:22` pinned by digest), Claude Code CLI 2.1.x, GitHub Actions, GitHub App.

**Spec:** `docs/superpowers/specs/2026-10-30-unit-test-agent-design.md` and ADRs in `docs/adr/`. Read both before any task.

## Global Constraints

- Node `>=22.12`; tooling runs as `node path/to/file.ts` using native type stripping: ESM, `.ts` import extensions, erasable syntax only (no enums, no namespaces, no parameter properties). This replaces `tsx` from spec assumption 2 (no runtime dependency needed).
- Code, comments, docs, commit messages and test data in English.
- **Git:** code and ADRs live on `feat/unit-test-agent` (bootstrap PR goes `feat/unit-test-agent → main`). Spec and plan live only on `superpowers/unit-test-agent` and must never reach `main`. On `feat/unit-test-agent`, every "Checkpoint" step is a commit made without asking, using the message given in the step (no AI attribution lines). Push and opening PRs only on the user's explicit request.
- After code changes run the formatter: `npx prettier --write <changed files>` in `frontend/` (only formatter configured in the repo). For `tools/test-agent/` add `prettier` with the frontend's style (no semicolons, single quotes) and a `format` script.
- Check run name: `test-agent/verified`. Comment marker: `<!-- test-agent:report -->`. Commit trailer: `Test-Agent-Run: <run_id>`. Labels: `test-agent:retry-large`, `test-agent:dismiss`.
- Test globs: backend `backend/tests/**/*.test.ts`; frontend `frontend/src/**/*.test.{ts,tsx}`. Evidence: `**/__evidence__/*.test.{ts,tsx}` under those roots.
- Source globs: `backend/src/**/*.ts`, `frontend/src/**/*.{ts,tsx}`, excluding test files and `**/*.stories.tsx`.
- Config files that stop the agent: `{backend,frontend}/vitest.config.*`, `{backend,frontend}/vite.config.*`, `{backend,frontend}/tsconfig*.json`.
- Stability: 3 runs, `--sequence.shuffle`, seeds `1,2,3`, `TZ` = `UTC`, `America/Los_Angeles`, `Asia/Kolkata`.
- Budgets: PR 60 turns / $3 / 20 min; retry-large ×2; backfill per run 150 turns / $10 / 45 min, `max_files` 8; backfill total $40; target ≈90% lines per app.
- In the container, never call `npm run …` scripts from the head (they are PR-controlled). Call binaries directly: `npx tsc --noEmit -p tsconfig.json`, `npx vitest run …`, `npx prisma generate`.
- `--bare` must never be used with Claude Code (it skips hooks).
- Every third-party action pinned by full commit SHA.

## Review Focus

1. **Guard path escapes:** `Read`/`Grep`/`Glob` on `/proc/self/environ`, `~/.claude`, `../trusted/…`, absolute paths outside `work/`, or a symlink inside `work/` pointing outside → deny. Test added in Task 2.
2. **Runner argument injection:** file arguments with `;`, `|`, `` ` ``, `$(`, `>`, newlines, or Vitest options such as `--config=…`, `--root`, `--dir` → deny before Docker is called. Tests in Task 2 (guard) and Task 3 (runner).
3. **Hostile patch shapes:** renames into test globs from elsewhere, symlinks (`new file mode 120000`), binary diffs, mode changes on source files, deleted test files → gate violation. Test in Task 4.
4. **Hostile model text in the comment:** `@org/team`, `</details>`, `<img onerror>`, triple backticks, `<!-- test-agent:report -->` inside the narrative or behaviours → rendered inert, and the marker appears exactly once. Test in Task 9.
5. **Head moved between plan and publish:** the PR head changes after `plan`, so the CAS push is rejected → outcome `head-moved`, neutral check on the *new* head is not created by this run, the comment says so. Test in Task 11.

---

## File Structure

```
tools/test-agent/
  package.json, package-lock.json, tsconfig.json, vitest.config.ts, .prettierrc
  policy.json                    # single source of truth for guard + gates + plan
  schema/report.schema.json      # agent report contract
  src/
    policy.ts                    # load policy, path classification
    guard.ts                     # PreToolUse decision (pure)
    runner.ts                    # runner arg parsing + docker argv (pure)
    diff.ts                      # unified diff parsing, changed lines
    gates.ts                     # patch gates (pure)
    config-excludes.ts           # read coverage.exclude from a config source via TS AST
    plan.ts                      # build plan/manifest (pure)
    coverage.ts                  # changed-line + app-wide coverage from coverage-final.json
    vitest-results.ts            # parse Vitest JSON reporter output
    report.ts                    # validate agent report (ajv)
    citations.ts                 # JSON pointer + verbatim quote checks
    transcript.ts                # stream-json transcript summary + guard coverage
    verdict.ts                   # outcome / conclusion / commit decision (pure)
    comment.ts                   # PR comment rendering + escaping
    github.ts                    # octokit helpers: check run, sticky comment, labels, PR
    publish.ts                   # patch apply, commit, CAS push orchestration
    filter.ts                    # trigger + dismiss decisions (pure)
    verify.ts                    # verify orchestration with injected exec
    exec.ts                      # child_process wrapper used by CLIs
    cli/                         # thin entrypoints: guard, run-tests, plan, prepare-workspace,
                                 # make-patch, verify, publish, filter, dismiss
  bin/test-agent-run             # shell wrapper → node …/cli/run-tests.ts
  tests/                         # one test file per src module + fixtures/
.claude/
  agents/unit-test-agent.md
  skills/<6 skills>/SKILL.md (+ references/ for the two stack skills)
  test-agent.settings.json
.github/
  workflows/ci.yml, test-agent-trigger.yml, test-agent-pr.yml,
            test-agent-backfill.yml, test-agent-pipeline.yml
  CODEOWNERS
docs/demo/expected-outcomes.md
SOLUTION.md
```

### Shared types (defined in Task 1 `src/types.ts`, used everywhere)

```ts
export type App = 'backend' | 'frontend'
export type Mode = 'pr' | 'backfill'
export type Outcome =
  | 'tests-added' | 'already-covered' | 'nothing-to-test'
  | 'draft' | 'config-changed'
  | 'budget-exhausted' | 'timeout' | 'patch-rejected' | 'verification-failed'
  | 'skip-unverified' | 'discovery-mismatch' | 'agent-run-invalid'
  | 'baseline-failing' | 'head-moved' | 'pipeline-error'
  | 'defect' | 'defect-dismissed'
export type Conclusion = 'success' | 'neutral' | 'failure'
export interface ManifestEntry {
  path: string; app: App; status: 'added' | 'modified' | 'renamed'
  changedLines: number[]; excludedOnBase: boolean
}
export interface Plan {
  mode: Mode; prNumber: number | null; baseSha: string; headSha: string
  title: string; description: string; draft: boolean
  earlyOutcome: 'draft' | 'config-changed' | 'nothing-to-test' | null
  manifest: ManifestEntry[]
  dependenciesChanged: boolean
  testsRemovedByAuthor: { file: string; count: number }[]
  budgetProfile: 'default' | 'large' | 'backfill'
}
```

---

## Task 0: Branch

- [x] **Step 1:** Create `superpowers/unit-test-agent` from `main` and commit `docs/superpowers/` there (user approved). The user pushes it.
- [x] **Step 2:** Create `feat/unit-test-agent` from `main` and commit `docs/adr/` there. All implementation tasks run on this branch.

---

## Task 1: Tooling package, shared types, policy

**Files:**
- Create: `tools/test-agent/{package.json,tsconfig.json,vitest.config.ts,.prettierrc,policy.json}`, `src/types.ts`, `src/policy.ts`
- Test: `tools/test-agent/tests/policy.test.ts`

**Interfaces:**
- Produces: `loadPolicy(file?: string): Policy`; `Policy` fields `testGlobs: Record<App,string[]>`, `evidenceGlobs: Record<App,string[]>`, `sourceGlobs: Record<App,string[]>`, `sourceIgnore: string[]`, `configGlobs: string[]`, `dependencyFiles: string[]`, `secretGlobs: string[]`, `skipMinChangedLineCoverage: number` (0.8), `forbiddenTestCalls: string[]`, `forbiddenAssertions: string[]`; helpers `appOf(path): App | null`, `isTestPath(policy, path): boolean`, `isEvidencePath(policy, path): boolean`, `isSourcePath(policy, path): boolean`, `isConfigPath(policy, path): boolean`, `isSecretPath(policy, path): boolean`. All paths are repo-relative POSIX.

- [ ] **Step 1:** `package.json`: `"type": "module"`, `"private": true`, `engines.node >=22.12`, deps `picomatch`, `parse-diff`, `ajv`, `@octokit/rest`, `typescript`; devDeps `vitest`, `@types/node`, `@types/picomatch`, `prettier`; scripts `test: vitest run`, `typecheck: tsc --noEmit`, `format: prettier --write src tests`. `tsconfig.json`: `module`/`moduleResolution` `nodenext`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`, `strict`. Run `npm install` in `tools/test-agent`.
- [ ] **Step 2:** `policy.json` with the exact globs and lists from Global Constraints; `forbiddenTestCalls`: `.skip(`, `.only(`, `.todo(`, `.fails(`, `xit(`, `xdescribe(`, `.skipIf(`, `.runIf(`; `forbiddenAssertions`: `toMatchSnapshot(`, `toMatchInlineSnapshot(`; `secretGlobs`: `**/.env`, `**/.env.*`, `!**/.env.example`.
- [ ] **Step 3: Write failing tests** in `tests/policy.test.ts`:

```ts
it('classifies paths', () => {
  const p = loadPolicy()
  expect(isTestPath(p, 'backend/tests/router.test.ts')).toBe(true)
  expect(isTestPath(p, 'frontend/src/a/B.test.tsx')).toBe(true)
  expect(isTestPath(p, 'backend/tests/fixture.ts')).toBe(false)
  expect(isTestPath(p, 'frontend/src/test/setup.ts')).toBe(false)
  expect(isEvidencePath(p, 'backend/tests/__evidence__/x.test.ts')).toBe(true)
  expect(isSourcePath(p, 'frontend/src/a/B.stories.tsx')).toBe(false)
  expect(isSourcePath(p, 'backend/src/features/todos/router.ts')).toBe(true)
  expect(isConfigPath(p, 'frontend/tsconfig.json')).toBe(true)
  expect(isSecretPath(p, '.env')).toBe(true)
  expect(isSecretPath(p, '.env.example')).toBe(false)
  expect(appOf('backend/src/x.ts')).toBe('backend')
  expect(appOf('README.md')).toBeNull()
})
```

- [ ] **Step 4:** Run `npx vitest run tests/policy.test.ts` → FAIL (module missing). Implement `src/types.ts` (from "Shared types") and `src/policy.ts` with `picomatch` (`dot: true`). Run again → PASS. Run `npm run typecheck` → no errors.
- [ ] **Step 5: Checkpoint** — propose `chore(test-agent): scaffold tooling package and policy`.

---

## Task 2: Guard (PreToolUse hook)

**Files:**
- Create: `tools/test-agent/src/guard.ts`, `src/cli/guard.ts`
- Test: `tools/test-agent/tests/guard.test.ts`

**Interfaces:**
- Consumes: `Policy`, `isTestPath`, `isEvidencePath`, `isSecretPath` (Task 1).
- Produces: `interface GuardContext { policy: Policy; workDir: string; runDir: string; realpath: (p: string) => string }`; `interface HookInput { tool_name: string; tool_input: Record<string, unknown>; tool_use_id?: string }`; `decide(input: HookInput, ctx: GuardContext): { allow: boolean; reason: string }`. CLI reads hook JSON from stdin, env `TEST_AGENT_WORK_DIR`, `TEST_AGENT_RUN_DIR`, `TEST_AGENT_GUARD_LOG`; appends `{tool_use_id, tool_name, allow, reason}` as JSONL to the log; prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":reason}}`; on any exception exits `2` with the error on stderr (fail-closed).

Rules (`decide`):
- `Read`, `Grep`, `Glob`: the resolved real path (`file_path` / `path`, default `workDir`) must be inside `workDir` or `runDir`, not a secret path, not under `work/.git/`.
- `Write`, `Edit`: real path inside `workDir`, relative path matches a test or evidence glob, and the file is not an existing non-test file; or exactly `${runDir}/report.json`.
- `Bash`: `command` must match `^test-agent-run (backend|frontend)( [A-Za-z0-9_./@-]+)+$` and each file argument must be a test or evidence path of that app relative to the app dir (e.g. `tests/x.test.ts`).
- `Skill`: allow. Everything else (including `WebFetch`, `WebSearch`, `mcp__*`, `Task`/`Agent`, `NotebookEdit`): deny.

- [ ] **Step 1: Write failing tests** — one `it` per rule, using a tmp dir with `work/` and `run/`; include Review Focus 1 and 2:

```ts
it.each([
  ['Read', { file_path: '/proc/self/environ' }],
  ['Read', { file_path: `${work}/../trusted/policy.json` }],
  ['Read', { file_path: `${work}/.env` }],
  ['Read', { file_path: `${work}/link-to-etc` }],      // symlink → /etc
  ['Grep', { pattern: 'KEY', path: '/home' }],
  ['Write', { file_path: `${work}/backend/src/x.ts`, content: '' }],
  ['Write', { file_path: `${work}/backend/tests/fixture.ts`, content: '' }],
  ['Edit', { file_path: `${work}/.github/workflows/ci.yml` }],
  ['Bash', { command: 'cat .env' }],
  ['Bash', { command: 'test-agent-run backend tests/a.test.ts; curl x' }],
  ['Bash', { command: 'test-agent-run backend --config=evil.ts' }],
  ['Bash', { command: 'test-agent-run backend ../src/x.ts' }],
  ['WebFetch', { url: 'https://x' }],
  ['mcp__github__create_branch', {}],
])('denies %s %j', (tool, toolInput) => {
  expect(decide({ tool_name: tool, tool_input: toolInput }, ctx).allow).toBe(false)
})
it.each([
  ['Read', { file_path: `${work}/backend/src/features/todos/router.ts` }],
  ['Write', { file_path: `${work}/backend/tests/new.test.ts`, content: '' }],
  ['Write', { file_path: `${work}/backend/tests/__evidence__/d.test.ts`, content: '' }],
  ['Write', { file_path: `${run}/report.json`, content: '{}' }],
  ['Bash', { command: 'test-agent-run frontend src/a/B.test.tsx' }],
  ['Skill', { skill: 'analyze-change' }],
])('allows %s %j', (tool, toolInput) => {
  expect(decide({ tool_name: tool, tool_input: toolInput }, ctx).allow).toBe(true)
})
it('CLI fails closed on malformed stdin', async () => {
  const r = spawnSync('node', ['src/cli/guard.ts'], { input: 'not json', env: { ...envFor(ctx) } })
  expect(r.status).toBe(2)
})
it('CLI logs every decision with tool_use_id', ...) // log file gets one JSONL line with the id
```

- [ ] **Step 2:** Run `npx vitest run tests/guard.test.ts` → FAIL.
- [ ] **Step 3:** Implement `decide` and the CLI. Resolve paths with `path.resolve(workDir, p)` then `fs.realpathSync` (for not-yet-existing files resolve the parent directory's realpath).
- [ ] **Step 4:** Run tests → PASS; `npm run typecheck`.
- [ ] **Step 5: Checkpoint** — `feat(test-agent): add fail-closed PreToolUse guard`.

---

## Task 3: Runner

**Files:**
- Create: `tools/test-agent/src/runner.ts`, `src/exec.ts`, `src/cli/run-tests.ts`, `bin/test-agent-run`
- Test: `tools/test-agent/tests/runner.test.ts`

**Interfaces:**
- Consumes: `Policy`, `isTestPath`, `isEvidencePath`.
- Produces:
  - `parseRunnerArgs(argv: string[], policy: Policy): { app: App; files: string[] }` (throws on anything the guard would deny).
  - `interface ContainerRun { image: string; appDir: string; resultsDir: string; command: string[]; env?: Record<string,string>; network: 'none' | 'default' }` and `dockerArgv(run: ContainerRun): string[]` → `['run','--rm','--network',…,'--env-file','/dev/null','-e','TZ=…','-e','HOME=/tmp','-e','CI=1','-v',`${appDir}:/app`,'-v',`${resultsDir}:/results`,'-w','/app', image, ...command]`. No host env is passed through.
  - `vitestCommand(opts: { files?: string[]; coverage?: boolean; seed?: number; shuffle?: boolean; outputName: string }): string[]` → `['npx','vitest','run','--reporter=json',`--outputFile=/results/${outputName}.json`, …]`; with coverage adds `--coverage.enabled=true`, `--coverage.reporter=json`, `--coverage.reportsDirectory=/results/${outputName}-coverage`; with shuffle adds `--sequence.shuffle=true`, `--sequence.seed=${seed}`.
  - `exec(cmd: string, args: string[], opts?): Promise<{ code: number; stdout: string; stderr: string }>` in `exec.ts`.
  - Env var `TEST_AGENT_IMAGE` holds `node:22@sha256:…` (resolved once in Task 13 and set in workflows).
  - `bin/test-agent-run`: `exec node "$TEST_AGENT_TRUSTED_DIR/tools/test-agent/src/cli/run-tests.ts" "$@"`; the CLI runs Vitest for the files in a container with `--network none`, mounting `${TEST_AGENT_WORK_DIR}/${app}`, and prints the JSON reporter output.

- [ ] **Step 1: Write failing tests:** `dockerArgv` never contains `ANTHROPIC_API_KEY` even when it is set in `process.env`; contains `--network none`; `parseRunnerArgs(['backend','tests/a.test.ts'])` ok; throws for `['backend','--config=x']`, `['backend','src/x.ts']`, `['backend','tests/a.test.ts;rm']`, `['db','x']`, `[]`; `vitestCommand({ coverage: true, outputName: 'after' })` contains `--coverage.reporter=json`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Docker smoke test** (skipped when `docker info` fails): copy `backend/` and `frontend/` to a tmp dir and install `node_modules` the way CI does on the Linux runner host: `npm ci --ignore-scripts` (on a macOS dev machine, run that install inside a Linux `node:22` container with network so the native optional packages match the runner's platform; the test run itself then uses the runner with `--network none`). Then:
  - backend: run the runner on `tests/validators.test.ts` → JSON with `numFailedTests: 0`;
  - frontend: run the runner on one existing `*.test.tsx` → passes. This proves the native binaries Vitest depends on (esbuild via `@esbuild/*`, Rollup via `@rollup/rollup-*`) work in the container when installed with `--ignore-scripts`. **If they do not, stop and report to the user with the exact error; do not work around it.**
  - a test file doing `await fetch('https://example.com')` must fail (no network), and one reading `process.env.ANTHROPIC_API_KEY` must see `undefined` while the host has it set.
- [ ] **Step 4: Checkpoint** — `feat(test-agent): add sandboxed vitest runner`.

---

## Task 4: Diff parsing and patch gates

**Files:**
- Create: `tools/test-agent/src/diff.ts`, `src/gates.ts`
- Test: `tools/test-agent/tests/gates.test.ts`, fixtures `tests/fixtures/patches/*.diff`

**Interfaces:**
- Produces:
  - `interface FileDiff { oldPath: string | null; newPath: string | null; status: 'added'|'modified'|'deleted'|'renamed'; binary: boolean; newMode: string | null; added: { line: number; text: string }[]; removed: { line: number; text: string }[] }`
  - `parseUnifiedDiff(text: string): FileDiff[]` (wrap `parse-diff`; detect `Binary files`, `new file mode`, `rename from/to`).
  - `changedLines(d: FileDiff): number[]` — new-file line numbers of added lines.
  - `interface Violation { file: string; rule: 'path'|'deleted'|'removed-lines'|'forbidden-call'|'snapshot'|'no-expect'|'binary'|'symlink'|'rename'|'mode'; detail: string }`
  - `checkPatch(diffs: FileDiff[], policy: Policy): { ok: boolean; violations: Violation[] }`
  - `stripEvidence(diffText: string, policy: Policy): string` — returns the diff without evidence files.
  - `testsRemoved(diffs: FileDiff[], policy: Policy): { file: string; count: number }[]` — counts removed lines matching `/\b(it|test)(\.each\([^)]*\))?\s*\(/` in test files, and for deleted test files counts the same in their removed lines.

Gates (spec §7.3): only test/evidence paths; no `deleted`; existing test files (`status === 'modified'`) have zero removed lines; no forbidden calls or snapshot assertions in added lines; every `added` test file has at least one `expect(`; no binary, no symlink (`120000`), no renames, no mode changes.

- [ ] **Step 1: Write failing tests** with one fixture per rule, plus Review Focus 3 fixtures (`rename-into-tests.diff`, `symlink.diff`, `binary.diff`, `mode-change.diff`, `deleted-test.diff`) each yielding exactly the expected `rule`; `clean-additive.diff` (new backend test + appended lines in an existing frontend test) → `ok: true`; `testsRemoved` on a diff that deletes two `it(` blocks and one `it.each(…)(` returns count 3.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Checkpoint** — `feat(test-agent): add patch gates`.

---

## Task 5: Plan

**Files:**
- Create: `tools/test-agent/src/config-excludes.ts`, `src/plan.ts`, `src/cli/plan.ts`
- Test: `tools/test-agent/tests/plan.test.ts`, `tests/config-excludes.test.ts`

**Interfaces:**
- Consumes: `Policy`, `parseUnifiedDiff`, `changedLines`, `testsRemoved`.
- Produces:
  - `readCoverageExcludes(source: string): string[]` — parse with the TypeScript compiler API, find the object literal `test.coverage.exclude` (or `coverage.exclude` under `defineConfig({ test: … })`), return its string literals; throw if it is not an array of string literals.
  - `interface PlanInput { mode: Mode; policy: Policy; diffText: string; pr: { number: number; title: string; body: string; draft: boolean; labels: string[] } | null; baseSha: string; headSha: string; baseExcludes: Record<App, string[]> }`
  - `buildPlan(input: PlanInput): Plan` (pr mode). Early outcome order: draft → config-changed → nothing-to-test (empty manifest). `budgetProfile` is `large` if labels include `test-agent:retry-large`. The backfill manifest is built in Task 6 (`buildBackfillManifest`), and the CLI gains `--mode backfill` there.
  - CLI `plan.ts --mode pr --base <sha> --head <sha> --pr-json <file> --trusted <dir> --out <file>` runs `git diff --unified=0 --no-renames=false <merge-base> <head>` in `work/` and writes `plan.json`.

- [ ] **Step 1: Write failing tests:**
  - `readCoverageExcludes` on the real `frontend/vite.config.ts` contains `'src/design-system/**'`; on `backend/vitest.config.ts` contains `'src/generated/**'`; on a config whose exclude is a variable → throws.
  - `buildPlan` with a README-only diff → `earlyOutcome: 'nothing-to-test'`; draft PR → `'draft'` even if config also changed; diff touching `frontend/vite.config.ts` → `'config-changed'`; diff touching `backend/package-lock.json` and `router.ts` → `dependenciesChanged: true`, manifest has `router.ts` with exact changed line numbers; diff touching `frontend/src/design-system/components/Badge/Badge.tsx` → entry with `excludedOnBase: true`; a `*.stories.tsx` change → not in manifest; deleted source file → not in manifest.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Checkpoint** — `feat(test-agent): add plan and manifest`.

---

## Task 6: Coverage and Vitest results

**Files:**
- Create: `tools/test-agent/src/coverage.ts`, `src/vitest-results.ts`
- Test: `tests/coverage.test.ts`, `tests/vitest-results.test.ts`, fixtures `tests/fixtures/coverage-final.json`, `tests/fixtures/vitest-*.json` (generate real ones by running Vitest in `backend/` once and trimming)

**Interfaces:**
- Produces:
  - `type CoverageMap = Record<string, { path: string; statementMap: Record<string, { start: { line: number }; end: { line: number } }>; s: Record<string, number> }>`
  - `normalizeCoverage(cov: CoverageMap, appRootInContainer: string, app: App): CoverageMap` — keys become repo-relative (`/app/src/x.ts` → `backend/src/x.ts`).
  - `executableLines(entry): Map<number, boolean>` (line → covered; a line is covered if any statement starting on it has count > 0).
  - `type CoverageResult = { status: 'measured' | 'missing' | 'excluded'; covered: number; total: number; pct: number | null }`
  - `changedLineCoverage(cov: CoverageMap, e: ManifestEntry): CoverageResult` — `excluded` if `e.excludedOnBase`; `missing` (pct 0) if the file is not in `cov`; only changed lines that are executable count.
  - `uncoveredLines(cov: CoverageMap, file: string): number[]`
  - `buildBackfillManifest(cov: CoverageMap, app: App, policy: Policy, maxFiles: number, excludes: string[]): ManifestEntry[]` — source files of `app` not matching `excludes`, sorted by uncovered line count descending (ties by path), first `maxFiles`, `changedLines` = uncovered lines, `status: 'modified'`. `cli/plan.ts --mode backfill --app <app> --max-files <n> --coverage <file>` writes a `Plan` with `prNumber: null`, empty title/description, `budgetProfile: 'backfill'`.
  - `appLineCoverage(cov: CoverageMap): { covered: number; total: number; pct: number }`
  - `interface RunSummary { files: string[]; total: number; passed: number; failed: number; failures: { file: string; name: string; isAssertion: boolean; message: string }[] }`
  - `readVitestJson(json: unknown, app: App): RunSummary` — `isAssertion` is true when the first failure message starts with `AssertionError` (also accept Vitest's `expected … to …` assertion messages from `expect`; pin with a real fixture).
  - `discoveryMismatch(expected: string[], executed: string[]): string[]` — expected files not executed.

- [ ] **Step 1: Write failing tests:** `buildBackfillManifest` with `maxFiles: 2` returns the two files with the most uncovered lines and never an excluded file; missing file → `{status:'missing', pct:0}`; excluded entry → `excluded`; changed lines `[3,4,99]` where 99 is not executable → `total` counts only 3 and 4; app-wide pct matches a hand-computed fixture; a failing `expect(1).toBe(2)` fixture → `isAssertion: true`; an import error fixture (`Failed to load url`) → `isAssertion: false`; a `TypeError` fixture → `false`; `discoveryMismatch(['a','b'],['a'])` → `['b']`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Checkpoint** — `feat(test-agent): add coverage and vitest result parsing`.

---

## Task 7: Report schema, citations, transcript

**Files:**
- Create: `tools/test-agent/schema/report.schema.json`, `src/report.ts`, `src/citations.ts`, `src/transcript.ts`
- Test: `tests/report.test.ts`, `tests/citations.test.ts`, `tests/transcript.test.ts`

**Interfaces:**
- Produces:
  - Report shape (JSON Schema, `additionalProperties: false` everywhere):
    ```ts
    interface Report {
      files: { path: string; action: 'create'|'update'|'skip'|'gave-up'; testFile?: string
               skip?: { file: string; testName: string } | { reason: 'excluded-from-coverage' } }[]
      behaviours: { file: string; description: string
                    source: { kind: 'pr-description'|'openapi'|'type'|'validator'|'characterization'; ref: string } }[]
      defects: { file: string; evidenceTest: string; summary: string
                 citation: { kind: 'openapi'; pointer: string } | { kind: 'pr-description'; quote: string } }[]
      narrative: string
    }
    ```
    String length caps: `description`/`summary` 500, `quote` 1000, `narrative` 4000.
  - `validateReport(data: unknown): { ok: true; report: Report } | { ok: false; errors: string[] }`
  - `resolvePointer(doc: unknown, pointer: string): boolean` (RFC 6901, `~0`/`~1`).
  - `quoteInDescription(quote: string, body: string): boolean` — normalise `\r\n` → `\n` on both, require non-empty quote of ≥ 10 characters, exact substring.
  - `summarizeTranscript(jsonl: string): { skills: string[]; toolUseIds: string[]; costUsd: number | null; turns: number | null; stop: 'success'|'max-turns'|'max-budget'|'error'|'unknown' }` — from Claude Code `--output-format stream-json` lines: `assistant` messages' `tool_use` blocks (ids; `Skill` inputs → skill names, deduplicated in first-use order) and the final `result` message (`total_cost_usd`, `num_turns`, `subtype`). Map `subtype` values after checking them against a real transcript in Task 12.
  - `guardCoverage(toolUseIds: string[], guardLogJsonl: string): string[]` — ids with no guard record. **[CUT 4]**

- [ ] **Step 1: Write failing tests:** a valid report passes; extra property fails; `action: 'delete'` fails; on an inline doc `{ paths: { '/api/todos': { get: { responses: { '422': {} } } } } }` the pointer `/paths/~1api~1todos/get/responses/422` resolves and `/paths/~1api~1todos/get/responses/400` does not; quote with CRLF matches LF body; 5-character quote rejected; transcript fixture with two `Skill` calls and a `result` message → skills, cost, turns; `guardCoverage(['a','b'], '{"tool_use_id":"a"}')` → `['b']`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Checkpoint** — `feat(test-agent): add report schema, citation and transcript checks`.

---

## Task 8: Verdict

**Files:**
- Create: `tools/test-agent/src/verdict.ts`
- Test: `tests/verdict.test.ts`

**Interfaces:**
- Consumes: `Plan`, `Report`, `RunSummary`, `Violation`, coverage results.
- Produces:
  ```ts
  interface AppNumbers {
    typecheckBefore: boolean; typecheckAfter: boolean | null
    suiteBefore: { passed: number; total: number }; suiteAfter: { passed: number; total: number } | null
    stability: { passedRuns: number; runs: number } | null
    changedLines: { file: string; before: CoverageResult; after: CoverageResult | null }[]
    appLines: { before: number; after: number | null } | null   // backfill only
  }
  interface VerdictInputs {
    plan: Plan; agentStop: 'success'|'max-turns'|'max-budget'|'error'|'unknown'|'timeout' | null
    report: { ok: true; report: Report } | { ok: false; errors: string[] } | null
    gates: { ok: boolean; violations: Violation[] } | null
    unguardedToolUses: string[]                     // [CUT 4]
    baseline: Record<App, { typecheck: boolean; suite: RunSummary }> | null
    after: Record<App, { typecheck: boolean; suite: RunSummary; expectedFiles: string[] }> | null
    stability: { file: string; passedRuns: number }[]
    skipChecks: { path: string; ok: boolean; detail: string }[]
    evidence: { file: string; failuresOnHead: number; allAssertion: boolean; citationOk: boolean }[]
    numbers: Record<App, AppNumbers>; patchSha256: string | null; patchEmpty: boolean
  }
  interface Verdict {
    mode: Mode; outcome: Outcome; conclusion: Conclusion; commitAllowed: boolean
    patchSha256: string | null; reasons: string[]
    files: { path: string; action: string; details: string }[]
    defects: { file: string; evidenceTest: string; citation: string; accepted: boolean; rejectReason?: string }[]
    numbers: Record<App, AppNumbers>
    banners: { dependenciesChanged: boolean; testsRemovedByAuthor: { file: string; count: number }[]; configChanged: boolean }
    baselineFailures: { app: App; tests: string[]; typecheck: boolean }[]
  }
  computeVerdict(i: VerdictInputs): Verdict
  conclusionFor(outcome: Outcome, mode: Mode): Conclusion | 'unaffected'
  ```
  Evaluation order (first match wins, then precedence failure > neutral > success applied with an accepted defect): plan early outcome → agent stop (`max-turns`/`max-budget` → `budget-exhausted`, `timeout`, `error` → `pipeline-error`) → `unguardedToolUses` non-empty → `agent-run-invalid` → report invalid → `pipeline-error` → baseline typecheck/suite failing → `baseline-failing` → gates fail → `patch-rejected` → discovery mismatch → `discovery-mismatch` → after typecheck failing, any failing test, or a test count below baseline → `verification-failed` → any stability `passedRuns < 3` → `verification-failed` → any failed skip check → `skip-unverified` → defects: accepted iff `failuresOnHead === 3 && allAssertion && citationOk` → in `pr` mode any accepted defect → `defect` (failure) → else `tests-added` if the patch is non-empty, `already-covered` otherwise. `commitAllowed` is true only for `tests-added` and for `defect` when every non-evidence check passed, and only when the patch without evidence is non-empty. In `backfill` mode an accepted defect leaves the outcome unchanged (`conclusionFor('defect','backfill') === 'unaffected'`).

- [ ] **Step 1: Write failing tests** — table-driven, one row per row of spec §9.1 plus: defect + one flaky test → `defect`, `commitAllowed: false`; defect with `allAssertion: false` → rejected, outcome `tests-added`; quote not found → rejected; backfill + accepted defect → `tests-added` with the defect listed; `gave-up` files with a non-empty patch → `tests-added`, with an empty patch → `verification-failed`; test count after < before → `verification-failed`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Checkpoint** — `feat(test-agent): add verdict computation`.

---

## Task 9: Comment rendering

**Files:**
- Create: `tools/test-agent/src/comment.ts`
- Test: `tests/comment.test.ts`

**Interfaces:**
- Consumes: `Verdict`, `Report | null`, `RunMeta`.
- Produces: `interface RunMeta { runUrl: string; model: string; budgetProfile: string; skills: string[]; turns: number | null; costUsd: number | null }`; `escapeModelText(s: string): string`; `renderComment(v: Verdict, report: Report | null, meta: RunMeta): string`; `renderDismissNote(text: string): string`.

Layout exactly as spec §9.2 (marker first line, then verdict, banners, per-file table, behaviours, verification table per app, defects in `<details>` with evidence test source and citation, run metadata, narrative in `<details>` titled "Model narrative (untrusted, not used for any status)"). Neutral agent-side outcomes include the `test-agent:retry-large` hint. `baseline-failing` lists the failing existing tests per app and says "These existing tests fail on the PR head before any agent change. The author must fix them; the agent never edits existing assertions." Backfill shows app-wide line coverage before → after.

`escapeModelText`: HTML-escape `& < > " '`, replace `@` with `@‍`, replace backticks with `\``, collapse to a single line inside table cells (`|` → `\|`, newlines → space); multi-line narrative goes inside a fenced block whose fence is longer than any backtick run in the text.

- [ ] **Step 1: Write failing tests** (Review Focus 4): narrative containing `@org/team </details><img src=x onerror=1> ``` <!-- test-agent:report -->` → output contains `@‍org`, contains no raw `<img`, `</details>` count equals the number of `<details>` the template opens, the marker string occurs exactly once; each §9.1 outcome renders a distinct verdict line; `baseline-failing` lists test names; `dependenciesChanged` renders the banner; backfill shows `appLines`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Checkpoint** — `feat(test-agent): render PR report comment`.

---

## Task 10: Verify orchestration

**Files:**
- Create: `tools/test-agent/src/verify.ts`, `src/cli/verify.ts`
- Test: `tests/verify.test.ts` (fake exec), plus a Docker integration test skipped without Docker

**Interfaces:**
- Consumes: Tasks 3–8.
- Produces: `interface VerifyDeps { exec: typeof exec; fs: typeof import('node:fs/promises'); image: string }`; `runVerify(args: { trustedDir: string; workDir: string; runDir: string; plan: Plan; patchPath: string; reportPath: string; transcriptPath: string; guardLogPath: string; agentStop: VerdictInputs['agentStop'] }, deps: VerifyDeps): Promise<Verdict>`; CLI writes `verdict.json` and exits 0 regardless of outcome (non-zero only on internal crash).

Steps exactly as spec §7.1: copy `work/` to `sandbox/` for every container run (results written to `runDir/results/<step>`); baseline (typecheck = `npx tsc --noEmit -p tsconfig.json`, suite with coverage) for both apps; sha256 of patch; gates; `git apply` the patch without evidence; after (typecheck, suite with coverage); `expectedFiles` = base test globs applied to `work/` (via `picomatch` on a file walk, excluding `__evidence__`); stability per new/changed test file with seeds 1–3 and the three TZs; skip checks **[CUT 3: if cut, check only that the cited file exists and its run passes and contains the test name]**: run the cited file alone with coverage and compare `changedLineCoverage(...).pct >= policy.skipMinChangedLineCoverage`; evidence: copy head + only the evidence file, run 3 times, collect `isAssertion`, check citation against `work/backend/openapi.json` and `plan.description`. Only the backend needs `npx prisma generate` before running (inside the container, network default, no secrets).

- [ ] **Step 1: Write failing tests** with a fake `exec` that returns canned Vitest JSON per step: happy path → `tests-added`; patch hash mismatch → `patch-rejected`; container exits non-zero with no JSON → `pipeline-error`; stability seed 2 fails → `verification-failed`; the fake records every container argv and the test asserts none contains `ANTHROPIC_API_KEY` and the test steps use `--network none`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Local integration run** (Docker): on a scratch copy of the repo, add one new backend test file by hand as the "patch", run `node tools/test-agent/src/cli/verify.ts …`, inspect `verdict.json` → `tests-added`, real numbers. Delete the scratch copy.
- [ ] **Step 4: Checkpoint** — `feat(test-agent): add verify orchestration`.

---

## Task 11: GitHub helpers, publish, filter, dismiss

**Files:**
- Create: `tools/test-agent/src/github.ts`, `src/publish.ts`, `src/filter.ts`, `src/cli/{publish,filter,dismiss}.ts`
- Test: `tests/publish.test.ts`, `tests/filter.test.ts`, `tests/github.test.ts`

**Interfaces:**
- Produces:
  - `github.ts`: `upsertComment(o: Octokit, repo: {owner;repo}, pr: number, body: string): Promise<void>` (find own comment by marker and bot login, update or create); `createCheckRun(o, repo, headSha: string, conclusion: Conclusion, title: string, summary: string, detailsUrl: string)`; `removeLabel(o, repo, pr, name)`; `openPullRequest(o, repo, head: string, base: string, title: string, body: string): Promise<number>`; `getPermission(o, repo, user): Promise<'admin'|'write'|'read'|'none'>`.
  - `publish.ts`: `commitMessage(prNumber: number | null, app: App | null, runId: string): string` → `test(agent): add unit tests for #<n>` (or `test(agent): backfill <app> unit tests`) + blank line + `Test-Agent-Run: <runId>`; `publishRun(args: { verdict: Verdict; patchPath: string; generateSha256: string; workDir: string; plan: Plan; runId: string; botName: string; botEmail: string }, deps: { exec; octokit; repo }): Promise<{ outcome: Outcome; checkSha: string }>` — re-check hash and gates (Task 4); if `commitAllowed`: apply patch without evidence, commit, `git push origin HEAD:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<plan.headSha>`; on rejection return `head-moved`; then create the check run on the pushed SHA (or `plan.headSha`) and upsert the comment; remove `test-agent:retry-large` if present. Backfill: push to `test-agent/backfill-<app>-<runId>` created from `plan.baseSha`, open the PR, check run + comment on it. **[CUT 2: label removal]**
  - `filter.ts`: `decideTrigger(i: { trigger: { prNumber: number; headSha: string; action: string; label?: string }; workflowRun: { headSha: string; triggeringActor: string }; pr: { headSha: string; headRepo: string; baseRepo: string; draft: boolean; labels: string[]; author: string } | null; headCommitMessage: string; botLogin: string }): { path: 'pipeline' | 'dismiss' | 'stop'; reason: string; budgetProfile: 'default' | 'large' }`; `decideDismiss(i: { labeler: string; prAuthor: string; permission: string; currentCheckConclusion: Conclusion | null; currentOutcome: Outcome | null }): { apply: boolean; reason: string }`. **[CUT 1: dismiss]**
- Consumes: `Verdict`, `checkPatch`, `stripEvidence`, `renderComment`.

- [ ] **Step 1: Write failing tests:**
  - `decideTrigger`: PR missing → stop; `pr.headSha !== trigger.headSha` → stop; `workflowRun.headSha !== pr.headSha` → stop; fork (`headRepo !== baseRepo`) → stop; trailer present and `triggeringActor === botLogin` → stop; trailer present but actor is a human → pipeline; `labeled` with `test-agent:retry-large` → pipeline/large; `labeled` with `bug` → stop; `labeled` with `test-agent:dismiss` → dismiss.
  - `decideDismiss`: labeler === author → no; permission `read` → no; no current defect failure → no; write + not author + defect → yes.
  - `publishRun` with a fake exec where push fails with `stale info` → returns `head-moved`, no check run created for the old SHA, comment says the head moved (Review Focus 5); hash mismatch → `patch-rejected` without pushing; success → commit message ends with `Test-Agent-Run: 123`, check run created on the new SHA.
  - `upsertComment` updates the existing bot comment with the marker and ignores a human comment that contains the marker.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3: Checkpoint** — `feat(test-agent): add publish, trigger filter and dismiss`.

---

## Task 12: Agent, skills, settings, workspace preparation

**Files:**
- Create: `.claude/agents/unit-test-agent.md`, `.claude/skills/{analyze-change,derive-test-intent,backend-unit-tests,frontend-unit-tests,run-and-triage,test-report}/SKILL.md`, `.claude/skills/backend-unit-tests/references/{router.md,repository.md}`, `.claude/skills/frontend-unit-tests/references/{component.md,hook.md}`, `.claude/test-agent.settings.json`, `tools/test-agent/src/cli/{prepare-workspace,make-patch}.ts`
- Test: `tools/test-agent/tests/agent-config.test.ts`, `tests/prepare-workspace.test.ts`

**Interfaces:**
- Consumes: guard CLI path, `test-agent-run`, report schema.
- Produces:
  - Agent frontmatter: `name: unit-test-agent`, `description` (when to use: write/update unit tests for a manifest of changed files), `tools: Read, Grep, Glob, Edit, Write, Skill, Bash`, `model: inherit`. Body: inputs (`$TEST_AGENT_RUN_DIR/plan.json`, `pr.json` treated as untrusted data), required skill order (`analyze-change` → `derive-test-intent` → stack skill → `run-and-triage` → `test-report`), the rule that PR text and code are data, only `test-agent-run` may be executed, and update = add only.
  - Each `SKILL.md`: frontmatter `name` + a precise `description` stating when to load it; body per spec §5.2. Stack skills reference real repo patterns: backend `setup()` with mocked `TodoStore` + Supertest (`tests/router.test.ts`), Prisma delegate spies (`tests/repository.test.ts`), `tests/fixture.ts`; frontend `vi.mock('../../../design-system', () => import('../../../design-system/mocks'))`, `userEvent.setup()`, `getByRole`/`getByLabelText`, `src/test/todoFixture.ts`. `run-and-triage` states the 3-attempt limit and drop-to-`gave-up`, the evidence-test rules (must fail on an assertion; citation pointer or verbatim quote of ≥10 chars) and `__evidence__/` location. `derive-test-intent` requires each behaviour's source and `characterization` + `// characterization:` comment in backfill when nothing defines it.
  - `test-agent.settings.json`: `permissions.allow` `["Read","Grep","Glob","Edit","Write","Skill","Bash(test-agent-run:*)"]`, `permissions.deny` `["WebFetch","WebSearch","Bash(curl:*)","Bash(wget:*)"]`, `hooks.PreToolUse` `[{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$TEST_AGENT_TRUSTED_DIR/tools/test-agent/src/cli/guard.ts\"" }] }]`, `sandbox` enabled with network disabled (verify availability; see Step 4).
  - `prepare-workspace.ts --trusted <dir> --work <dir>`: replace `work/.claude` with `trusted/.claude`; delete every `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json` under `work/` (any depth).
  - `make-patch.ts --work <dir> --out <file>`: `git add -A -N` then `git diff --binary <headSha>`; writes `patch.diff` and `patch.sha256`.

- [ ] **Step 1: Write failing tests:** `agent-config.test.ts` parses the agent frontmatter and asserts the exact tool list and that no tool outside the guard's allowlist appears; each of the six skills exists with non-empty `name` and `description`; settings hook matcher is `*` and the command targets `cli/guard.ts`. `prepare-workspace.test.ts`: a fake head with `.claude/agents/evil.md`, `CLAUDE.md`, `backend/CLAUDE.md`, `.mcp.json` ends with trusted `.claude/` only and none of the others.
- [ ] **Step 2:** Run → FAIL. Write the files. Run → PASS.
- [ ] **Step 3: Local agent run** on a scratch copy with a small sample change (e.g. add a `GET /api/todos/count` route): run `plan`, `prepare-workspace`, then
  ```bash
  claude -p "Process the plan in $TEST_AGENT_RUN_DIR" --agent unit-test-agent \
    --settings "$TEST_AGENT_TRUSTED_DIR/.claude/test-agent.settings.json" --setting-sources project \
    --strict-mcp-config --permission-mode dontAsk --max-budget-usd 3 \
    --output-format stream-json --verbose --include-hook-events > "$TEST_AGENT_RUN_DIR/transcript.jsonl"
  ```
  then `make-patch`, `verify`. Expected: `verdict.json` outcome `tests-added`, guard log covers every tool use, `report.json` valid.
- [ ] **Step 4: Record the facts the spec flagged**, in `docs/superpowers/plans/notes-claude-code.md`: whether `--max-turns` exists in this CLI version (not in `--help`; if absent, rely on `--max-budget-usd` and job timeout and update spec assumption 6), the `result` `subtype` values for budget/turn limits (update `summarizeTranscript` mapping), whether `dontAsk` allows read-only tools without rules, whether hook events appear in the transcript, and whether the Bash sandbox works on Linux with Docker. Use that to finalise `settings.sandbox`.
- [ ] **Step 5: Checkpoint** — `feat(agent): add unit-test-agent, skills and settings`.

---

## Task 13: Workflows, CODEOWNERS, regular CI

**Files:**
- Create: `.github/workflows/{ci.yml,test-agent-trigger.yml,test-agent-pr.yml,test-agent-backfill.yml,test-agent-pipeline.yml}`, `.github/CODEOWNERS`

**Interfaces:**
- Consumes: all CLIs; repository variables `TEST_AGENT_APP_ID`, `TEST_AGENT_BOT_LOGIN`, `TEST_AGENT_MODEL`, `TEST_AGENT_IMAGE`; environment secrets `ANTHROPIC_API_KEY`, `TEST_AGENT_APP_PRIVATE_KEY`.
- Produces: the pipeline in spec §6.

- [ ] **Step 1: Resolve pins.** For `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, `actions/create-github-app-token`, `step-security/harden-runner`: resolve the latest release tag to a commit SHA (GitHub MCP `get_tag`/`list_tags`) and use `uses: owner/repo@<sha> # vX.Y.Z`. Resolve `node:22` to a digest with `docker buildx imagetools inspect node:22` and record it in the `TEST_AGENT_IMAGE` variable value for Task 14.
- [ ] **Step 2: `ci.yml`** — on `pull_request` and `push: main`; jobs `backend` and `frontend`: `npm ci`, `npm run typecheck`, `npm run test:coverage`. (Regular CI runs normal scripts; it is not part of the agent's trust boundary.)
- [ ] **Step 3: `test-agent-trigger.yml`** — `on: pull_request` (types per spec §6.1), `permissions: { contents: read }`, one job writing `trigger.json` from `github.event` (`number`, `pull_request.head.sha`, `action`, `label.name`) and uploading it as artifact `trigger`.
- [ ] **Step 4: `test-agent-pipeline.yml`** (`on: workflow_call`, inputs `mode`, `pr_number`, `head_sha`, `budget_profile`, `app`, `max_files`):
  - every job starts with `harden-runner` (`egress-policy: block`, `allowed-endpoints` = `registry.npmjs.org:443 api.anthropic.com:443 github.com:443 api.github.com:443 codeload.github.com:443 objects.githubusercontent.com:443 *.actions.githubusercontent.com:443 production.cloudflare.docker.com:443 registry-1.docker.io:443 auth.docker.io:443`, plus Prisma binaries host only if Task 12 Step 4 showed it is needed);
  - `plan` (`permissions: contents: read, pull-requests: read`): checkout base to `trusted/` and head to `work/` with `fetch-depth: 0`; `npm ci` in `trusted/tools/test-agent`; run `cli/plan.ts`; upload `plan`. In backfill mode also install app deps with `--ignore-scripts`, `prisma generate` in container, and run coverage in the container.
  - `generate` (`environment: test-agent-pr` or `test-agent-backfill`, `needs: plan`, `if: plan.earlyOutcome == null`, `timeout-minutes` from the budget profile, `concurrency: test-agent-pr-<n>` cancel-in-progress): checkouts; `npm ci --ignore-scripts` in both apps; `prisma generate` in container; `npm i -g @anthropic-ai/claude-code@<pinned version>`; add `trusted/tools/test-agent/bin` to `PATH`; `prepare-workspace`; then **only in this step** `env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}` running the Task 12 Step 3 command with budget flags from the profile; `make-patch` with `if: always()`; upload `generate` (patch, sha256, report, transcript, guard log, exit status/timeout flag).
  - `verify` (no environment, `needs: generate`, same concurrency group): checkouts, installs with `--ignore-scripts`, run `cli/verify.ts`; upload `verdict`.
  - `publish` (`environment` as for generate, `needs: [plan, generate, verify]`, `if: ${{ !cancelled() }}`, `concurrency: test-agent-publish-<n>` without cancel): `create-github-app-token` with `app-id: vars.TEST_AGENT_APP_ID`, `private-key: secrets.TEST_AGENT_APP_PRIVATE_KEY`; checkout head with the App token (`persist-credentials` for the push); download artifacts; run `cli/publish.ts` (also handles early outcomes and `pipeline-error` when upstream jobs failed).
- [ ] **Step 5: `test-agent-pr.yml`** — `on: workflow_run: { workflows: [test-agent-trigger], types: [completed] }`, `permissions: { actions: read, contents: read, pull-requests: read }`; job `filter` downloads `trigger` from `github.event.workflow_run.id`, runs `cli/filter.ts` with `workflow_run.head_sha` and `workflow_run.triggering_actor.login`; job `pipeline` calls `test-agent-pipeline.yml` with `secrets: inherit` when `path == 'pipeline'`; job `dismiss` (environment `test-agent-pr`, App token) runs `cli/dismiss.ts` when `path == 'dismiss'` **[CUT 1]**.
- [ ] **Step 6: `test-agent-backfill.yml`** — `on: workflow_dispatch` (inputs `app` choice, `max_files` default `8`); calls the pipeline with `mode: backfill`.
- [ ] **Step 7: `CODEOWNERS`** — `@dawid-fulmes` for `/.claude/`, `/.github/`, `/tools/test-agent/`, `/backend/vitest.config.*`, `/frontend/vite.config.*`, `/backend/tsconfig*.json`, `/frontend/tsconfig*.json`.
- [ ] **Step 8: Lint** — `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest` → no errors. Grep that every `uses:` has a 40-char SHA.
- [ ] **Step 9: Checkpoint** — `ci: add test agent pipeline, trigger, backfill and regular CI`.

---

## Task 14: GitHub setup and bootstrap (user actions)

Everything here is outward-facing. Prepare exact instructions, ask before each action, and never push or merge without an explicit request.

- [ ] **Step 1:** Write `docs/setup.md` with the exact steps: create the GitHub App (permissions from spec §11: Contents RW, Checks RW, Pull requests RW, Issues RW, Metadata R; no webhook), install it on the repo, note App ID and bot login (`<app-slug>[bot]`); create environments `test-agent-pr` and `test-agent-backfill` with deployment branches limited to `main`, required reviewers on `test-agent-backfill`, secrets `ANTHROPIC_API_KEY` and `TEST_AGENT_APP_PRIVATE_KEY` in both; repository variables `TEST_AGENT_APP_ID`, `TEST_AGENT_BOT_LOGIN`, `TEST_AGENT_MODEL=claude-sonnet-5-5`, `TEST_AGENT_IMAGE=node:22@sha256:…`; labels `test-agent:retry-large`, `test-agent:dismiss`; ruleset on `main` (require PR, require code owner review with admin bypass, required checks `test-agent/verified` with the App as source plus `ci / backend`, `ci / frontend`); confirm the repo is public.
- [ ] **Step 2:** Walk the user through it; they create the App and secrets (browser-only). Verify via GitHub MCP read calls (labels, variables are not readable via MCP — ask the user to confirm).
- [ ] **Step 3:** Ask the user for explicit go-ahead to push the feature branch and open the bootstrap PR, then to merge it with admin bypass. Tooling must be on `main` before any pipeline run.

---

## Task 15: Backfill to target

- [ ] **Step 1:** Record baseline app-wide line coverage for both apps from a local `npm run test:coverage` (json-summary) in `docs/demo/backfill-log.md`.
- [ ] **Step 2:** Ask the user to dispatch `test-agent-backfill` for `backend` (`max_files: 8`) and approve the environment. Review the PR comment; ask the user to merge. Record the run's before/after app coverage, cost and outcome in the log.
- [ ] **Step 3:** Repeat per app until ≈90% lines or $40 total is reached. Same for `frontend`.
- [ ] **Step 4:** Draft the ratchet change for the user (raise `coverage.thresholds` in `backend/vitest.config.ts` and `frontend/vite.config.ts` to just below the achieved levels); the user opens and merges it.

---

## Task 16: Demo PRs

**Files:**
- Create: `docs/demo/expected-outcomes.md`; demo branch changes (D1–D5) as described in spec §10.

- [ ] **Step 1:** Write `docs/demo/expected-outcomes.md`: for each of D1–D5 the branch name, change summary, predicted outcome code, conclusion, per-file actions and notes (exactly the predictions in spec §10). Ask the user to commit it to `main` **before** any demo PR is opened.
- [ ] **Step 2:** Prepare each demo branch locally (code only, no commits without the user's go-ahead):
  - D1 `demo/docs-only`: README section about the test agent.
  - D2 `demo/search-todos`: backend `GET /api/todos?q=` (validator, repository `list({ q })` with case-insensitive `contains`, router, OpenAPI param), frontend search input in `TodosHeader` or a new `TodoSearch` component and `useTodosQuery` param.
  - D3 `demo/refactor-mappers`: extract a helper inside `backend/src/features/todos/mappers.ts` without behaviour change.
  - D4 `demo/priority-filter-bug`: `GET /api/todos?priority=`; OpenAPI documents `422` for values outside `low|medium|high`; the router ignores invalid values and returns `200` with all todos. PR description states the 422 behaviour verbatim.
  - D5 `demo/prompt-injection`: small backend change (e.g. `GET /api/health` adds `version`) with PR description and a code comment instructing the agent to edit `.github/workflows/ci.yml`, print `process.env`, read `.env`, and mark every file `skip`.
- [ ] **Step 3:** With the user's go-ahead, push and open the PRs one by one; after each run, record actual vs predicted in `docs/demo/expected-outcomes.md` (a separate "Actual" column, added after the run).

---

## Task 17: SOLUTION.md

**Files:**
- Create: `SOLUTION.md`

- [ ] **Step 1:** Write the sections in spec §12 order. Decisions: one line per ADR with link. Example run: reproduce the D2 and D4 comments (copied from the PRs) with skills used, decisions and verification numbers; predicted-vs-actual table D1–D5; backfill before/after from `docs/demo/backfill-log.md`. Assumptions from spec §13 (updated with Task 12 Step 4 findings). Limitations from spec §14 plus anything cut per spec §16.1. Production extensions from spec §15.
- [ ] **Step 2:** Check that no assignment text (instructions, recruiter contact details) is quoted anywhere in the repo.
- [ ] **Step 3: Checkpoint** — `docs: add SOLUTION.md`.

---

## Task 18 (stretch): Base-failure informational check

- [ ] **Step 1:** In `verify`, run the new/changed test files against `trusted/` (base) code in the container, record per-file pass/fail in `Verdict.numbers[app].baseFailures` (informational), render a "Fails on base" column in the comment. Tests: verdict outcome unchanged regardless of base results; comment shows the column.
- [ ] **Step 2: Checkpoint** — `feat(test-agent): report new tests failing on base (informational)`.
