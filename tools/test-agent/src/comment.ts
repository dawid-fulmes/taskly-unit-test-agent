import type { CoverageResult } from './coverage.ts'
import type { Report } from './report.ts'
import type { App, Outcome } from './types.ts'
import type { AppNumbers, Verdict } from './verdict.ts'

/** Facts from the transcript and Claude Code's JSON result, never from model text. `null` renders as "n/a". */
export interface RunMeta {
  runUrl: string
  model: string
  budgetProfile: string
  skills: string[] | null
  turns: number | null
  costUsd: number | null
}

export const COMMENT_MARKER = '<!-- test-agent:report -->'

const ZWJ = '‍'
const GITHUB_COMMENT_LIMIT = 65536
// Leave headroom below GitHub's hard limit.
const SIZE_BUDGET = GITHUB_COMMENT_LIMIT - 1536
const MAX_BEHAVIOURS = 50
const MAX_NARRATIVE = 4000
const MAX_EVIDENCE = 8000
const MAX_FILE_ROWS = 200
const MAX_REASONS = 20
const MAX_BASELINE_TESTS = 50
const APPS: readonly App[] = ['backend', 'frontend']

const VERDICT_LINES: Record<Outcome, string> = {
  'tests-added': '✅ Tests added and verified',
  'already-covered': '✅ Already covered: existing tests cover every change',
  'nothing-to-test': '✅ Nothing to test in this change',
  draft: '⚪ Skipped: this PR is a draft',
  'config-changed':
    '⚪ Skipped: test or build configuration changed, human review required',
  'budget-exhausted': '⚪ Agent budget exhausted before finishing',
  timeout: '⚪ Agent run timed out',
  'patch-rejected': '⚪ Patch rejected by the safety gates, nothing committed',
  'verification-failed':
    '⚪ Verification failed, nothing committed (the generated tests did not pass the checks)',
  'skip-unverified':
    '⚪ A claimed skip could not be verified, nothing committed',
  'discovery-mismatch':
    '⚪ Verification inconclusive: expected test files did not run',
  'agent-run-invalid':
    '⚪ Agent run invalid: a tool call had no guard record, nothing committed',
  'baseline-failing':
    '⚪ Baseline failing: existing checks fail on the PR head before any agent change',
  'head-moved':
    '⚪ PR head moved while the agent ran, nothing committed by this run',
  'pipeline-error': '⚪ Pipeline error, no verdict could be produced',
  defect:
    '❌ Suspected defect found: a verified failing test contradicts the stated behaviour',
  'defect-dismissed': '⚪ Suspected defect dismissed by a maintainer',
}

const RETRY_HINT_OUTCOMES = new Set<Outcome>([
  'budget-exhausted',
  'timeout',
  'patch-rejected',
  'verification-failed',
  'skip-unverified',
])

/** Removes bidi and invisible control characters from model text. */
function stripInvisible(s: string): string {
  return s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
}

/** Breaks GitHub autolinks (issue refs, URLs, SHAs, emoji codes) so no cross-reference events fire. */
function breakAutolinks(s: string): string {
  return s
    .replace(/#(?=\d)/g, `#${ZWJ}`)
    .replace(/\bGH-(?=\d)/gi, `GH-${ZWJ}`)
    .replace(/:\/\//g, `:/${ZWJ}/`)
    .replace(/\bwww\./gi, `www${ZWJ}.`)
    .replace(/\b([0-9a-f]{6})(?=[0-9a-f]{1,34}\b)/gi, `$1${ZWJ}`)
    .replace(/:(?=[a-z0-9_+-]+:)/gi, `:${ZWJ}`)
}

/** HTML-escapes and neutralises mentions; never produces the comment marker. */
function htmlSafe(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/@/g, `@${ZWJ}`)
}

/** Single-line, Markdown- and HTML-inert text, safe inside table cells, list items and prose. */
export function escapeModelText(s: string): string {
  return htmlSafe(breakAutolinks(stripInvisible(s)))
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\s+/g, ' ')
}

/** HTML-only variant for text inside `<summary>`, where Markdown is not parsed. */
function summaryText(s: string): string {
  return htmlSafe(breakAutolinks(stripInvisible(s))).replace(/\s+/g, ' ')
}

function fence(content: string, lang = 'text'): string {
  const longest = Math.max(
    0,
    ...(content.match(/`+/g) ?? []).map((r) => r.length),
  )
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}${lang}\n${content}\n${f}`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s
}

/** For text inside a code fence: no HTML escaping, but no mentions, marker or details tags either. */
function fenceSafe(s: string): string {
  return stripInvisible(s)
    .replace(/@/g, `@${ZWJ}`)
    .replace(/<(?=\/?details|\/?summary|!--)/gi, `<${ZWJ}`)
}

function pct(r: CoverageResult | null): string {
  if (r === null) return 'n/a'
  if (r.status === 'excluded') return 'excluded from coverage'
  // ADR 0012: a file missing from the coverage report counts as 0%.
  if (r.status === 'missing') return '0% (not in coverage report)'
  if (r.pct === null || !Number.isFinite(r.pct)) return 'n/a'
  return `${Math.round(r.pct * 100)}% (${r.covered}/${r.total})`
}

function frac(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n)
    ? 'n/a'
    : `${Math.round(n * 1000) / 10}%`
}

function mark(b: boolean | null): string {
  return b === null ? 'n/a' : b ? 'pass' : 'fail'
}

const MAX_CELL = 500

function cell(s: string): string {
  return escapeModelText(
    s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s,
  )
}

interface Sections {
  narrative: boolean
  evidence: boolean
  behaviours: boolean
}

function bannerLines(v: Verdict): string[] {
  const out: string[] = []
  if (v.banners.dependenciesChanged)
    out.push(
      '> ⚠️ **Dependencies changed** in this PR. Review the dependency changes manually.',
    )
  if (v.banners.testsRemovedByAuthor.length > 0) {
    const total = v.banners.testsRemovedByAuthor.reduce(
      (n, t) => n + t.count,
      0,
    )
    out.push(
      `> ⚠️ **Tests removed by the author:** ${total} in ${v.banners.testsRemovedByAuthor
        .map((t) => `${cell(t.file)} (${t.count})`)
        .join(', ')}`,
    )
  }
  if (v.banners.configChanged)
    out.push(
      '> ⚠️ **Config changed:** test or build configuration was modified, human review required.',
    )
  return out
}

function filesTable(v: Verdict): string[] {
  if (v.files.length === 0) return []
  const rows = v.files
    .slice(0, MAX_FILE_ROWS)
    .map((f) => `| ${cell(f.path)} | ${cell(f.action)} | ${cell(f.details)} |`)
  const out = [
    '### Files',
    '',
    '| File | Action | Details |',
    '|---|---|---|',
    ...rows,
  ]
  if (v.files.length > MAX_FILE_ROWS)
    out.push('', `…and ${v.files.length - MAX_FILE_ROWS} more files`)
  return out
}

function behavioursSection(report: Report): string[] {
  if (report.behaviours.length === 0) return []
  const shown = report.behaviours.slice(0, MAX_BEHAVIOURS)
  const out = ['### Behaviours', '']
  for (const b of shown)
    out.push(
      `- ${cell(b.file)}: ${cell(b.description)} (source: ${cell(b.source.kind)} ${cell(b.source.ref)})`,
    )
  if (report.behaviours.length > shown.length)
    out.push(`- …and ${report.behaviours.length - shown.length} more`)
  return out
}

function appShown(n: AppNumbers): boolean {
  return (
    n.suiteBefore.total > 0 ||
    n.suiteAfter !== null ||
    n.changedLines.length > 0 ||
    n.appLines !== null
  )
}

function verificationSection(v: Verdict): string[] {
  const apps = APPS.filter((a) => appShown(v.numbers[a]))
  if (apps.length === 0) return []
  const out = [
    '### Verification',
    '',
    '| App | Typecheck (before → after) | Suites passed/total (before → after) | Stability |',
    '|---|---|---|---|',
  ]
  for (const a of apps) {
    const n = v.numbers[a]
    const suiteAfter = n.suiteAfter
      ? `${n.suiteAfter.passed}/${n.suiteAfter.total}`
      : 'n/a'
    const stability = n.stability
      ? `${n.stability.passedRuns}/${n.stability.runs}`
      : 'n/a'
    out.push(
      `| ${a} | ${mark(n.typecheckBefore)} → ${mark(n.typecheckAfter)} | ${n.suiteBefore.passed}/${n.suiteBefore.total} → ${suiteAfter} | ${stability} |`,
    )
  }
  const cov = apps.flatMap((a) =>
    v.numbers[a].changedLines.map((c) => ({ app: a, ...c })),
  )
  if (cov.length > 0) {
    out.push(
      '',
      '**Changed-lines coverage**',
      '',
      '| File | Before → after |',
      '|---|---|',
    )
    for (const c of cov.slice(0, MAX_FILE_ROWS))
      out.push(`| ${cell(c.file)} | ${pct(c.before)} → ${pct(c.after)} |`)
    if (cov.length > MAX_FILE_ROWS)
      out.push('', `…and ${cov.length - MAX_FILE_ROWS} more files`)
  }
  for (const a of apps) {
    const l = v.numbers[a].appLines
    if (l)
      out.push(
        '',
        `**${a} app-wide line coverage:** ${frac(l.before)} → ${frac(l.after)}`,
      )
  }
  return out
}

function baselineSection(v: Verdict): string[] {
  if (v.outcome !== 'baseline-failing' || v.baselineFailures.length === 0)
    return []
  const out = [
    '### Existing failures on the PR head',
    '',
    'These existing tests fail on the PR head before any agent change. The author must fix them; the agent never edits existing assertions.',
  ]
  for (const b of v.baselineFailures) {
    out.push('', `**${b.app}**`, '')
    if (b.typecheck) out.push('- typecheck fails')
    for (const t of b.tests.slice(0, MAX_BASELINE_TESTS))
      out.push(`- ${cell(t)}`)
    if (b.tests.length > MAX_BASELINE_TESTS)
      out.push(`- …and ${b.tests.length - MAX_BASELINE_TESTS} more`)
  }
  return out
}

function defectsSection(
  v: Verdict,
  report: Report | null,
  evidence: Record<string, string>,
  showEvidence: boolean,
): string[] {
  if (v.defects.length === 0) return []
  const out = ['### Defects']
  for (const d of v.defects) {
    const summary = report?.defects.find(
      (r) => r.file === d.file && r.evidenceTest === d.evidenceTest,
    )?.summary
    out.push(
      '',
      '<details>',
      `<summary>${d.accepted ? 'Suspected defect' : 'Defect claim rejected'}: ${summaryText(d.file)}</summary>`,
      '',
    )
    if (!d.accepted)
      out.push(
        `Rejected by deterministic verification: ${cell(d.rejectReason ?? 'unknown reason')}`,
        '',
      )
    if (summary !== undefined)
      out.push(`**Summary (model text):** ${cell(summary)}`, '')
    out.push(`**Citation:** ${cell(d.citation)}`, '')
    out.push(`**Evidence test:** ${cell(d.evidenceTest)}`, '')
    const src = evidence[d.evidenceTest]
    if (src !== undefined && showEvidence)
      out.push(fence(fenceSafe(truncate(src, MAX_EVIDENCE)), 'ts'), '')
    else if (src !== undefined)
      out.push('_Evidence source omitted to fit the comment size limit._', '')
    out.push('</details>')
  }
  return out
}

function metaSection(meta: RunMeta): string[] {
  const url = /^https:\/\/[^\s<>()[\]`"']+$/.test(meta.runUrl)
    ? `[run](${meta.runUrl})`
    : cell(meta.runUrl)
  const skills =
    meta.skills === null
      ? 'n/a'
      : meta.skills.length === 0
        ? 'none'
        : meta.skills.map(cell).join(', ')
  return [
    '### Run',
    '',
    `- Run: ${url}`,
    `- Model: ${cell(meta.model)}`,
    `- Budget profile: ${cell(meta.budgetProfile)}`,
    `- Skills used: ${skills}`,
    `- Turns: ${meta.turns === null ? 'n/a' : meta.turns}`,
    `- Cost: ${meta.costUsd === null ? 'n/a' : `$${meta.costUsd.toFixed(2)}`}`,
  ]
}

function narrativeSection(report: Report): string[] {
  return [
    '<details>',
    '<summary>Model narrative (untrusted, not used for any status)</summary>',
    '',
    fence(fenceSafe(truncate(report.narrative, MAX_NARRATIVE))),
    '',
    '</details>',
  ]
}

function build(
  v: Verdict,
  report: Report | null,
  meta: RunMeta,
  evidence: Record<string, string>,
  s: Sections,
  omitted: string[],
): string {
  const lines: string[] = [COMMENT_MARKER, '', `## ${VERDICT_LINES[v.outcome]}`]
  if (RETRY_HINT_OUTCOMES.has(v.outcome))
    lines.push(
      '',
      'Add the `test-agent:retry-large` label to re-run with a larger budget.',
    )
  const blocks: string[][] = [
    bannerLines(v),
    v.reasons.length > 0 && v.outcome !== 'tests-added'
      ? [
          '### Reasons',
          '',
          ...v.reasons.slice(0, MAX_REASONS).map((r) => `- ${cell(r)}`),
          ...(v.reasons.length > MAX_REASONS
            ? [`- …and ${v.reasons.length - MAX_REASONS} more`]
            : []),
        ]
      : [],
    baselineSection(v),
    filesTable(v),
    report && s.behaviours ? behavioursSection(report) : [],
    verificationSection(v),
    defectsSection(v, report, evidence, s.evidence),
    metaSection(meta),
    omitted.length > 0
      ? [`_Omitted to fit GitHub's comment size limit: ${omitted.join(', ')}._`]
      : [],
    report && s.narrative ? narrativeSection(report) : [],
  ]
  for (const b of blocks) if (b.length > 0) lines.push('', ...b)
  return lines.join('\n') + '\n'
}

/** Keeps the marker exactly once, as the first line, whatever the model text contained. */
function enforceMarker(text: string): string {
  const rest = text.slice(COMMENT_MARKER.length)
  return (
    COMMENT_MARKER +
    rest.split(COMMENT_MARKER).join(`<${ZWJ}!-- test-agent:report -->`)
  )
}

/**
 * Renders the single sticky PR comment. Numbers and statuses come from the verdict and run meta;
 * `evidence` maps an evidence test path to its source text (read by the caller).
 */
export function renderComment(
  v: Verdict,
  report: Report | null,
  meta: RunMeta,
  evidence: Record<string, string> = {},
): string {
  const s: Sections = { narrative: true, evidence: true, behaviours: true }
  const omitted: string[] = []
  const attempt = () => build(v, report, meta, evidence, s, omitted)
  let out = attempt()
  const drops: [keyof Sections, string][] = [
    ['narrative', 'model narrative'],
    ['evidence', 'evidence test sources'],
    ['behaviours', 'behaviours'],
  ]
  for (const [key, label] of drops) {
    if (out.length <= SIZE_BUDGET) break
    s[key] = false
    omitted.push(label)
    out = attempt()
  }
  if (out.length > SIZE_BUDGET)
    out = [
      COMMENT_MARKER,
      '',
      `## ${VERDICT_LINES[v.outcome]}`,
      '',
      "_The full report exceeds GitHub's comment size limit; see the run for details._",
      '',
      ...metaSection(meta),
      '',
    ].join('\n')
  return enforceMarker(out)
}

/** A short note for the dismiss path. Controller-provided text, escaped anyway. */
export function renderDismissNote(text: string): string {
  return `> **Dismissed:** ${escapeModelText(text)}\n`
}

/** The verdict line for an outcome (comment heading and check run title). */
export function verdictLine(outcome: Outcome): string {
  return VERDICT_LINES[outcome]
}

// Model text can never produce this line: `<` is HTML-escaped in prose and `<!--` is broken in fences.
const OUTCOME_MARKER = /\n?<!-- test-agent:outcome ([a-z-]+) -->\n?$/

/** Appends (or replaces) the machine-readable outcome line that the dismiss path reads back. */
export function withOutcomeMarker(body: string, outcome: Outcome): string {
  const rest = body.replace(OUTCOME_MARKER, '')
  return `${rest.endsWith('\n') ? rest : `${rest}\n`}<!-- test-agent:outcome ${outcome} -->\n`
}

export function outcomeFromComment(body: string): Outcome | null {
  const m = OUTCOME_MARKER.exec(body.replace(/\r\n/g, '\n'))
  const o = m?.[1]
  return o !== undefined && Object.hasOwn(VERDICT_LINES, o)
    ? (o as Outcome)
    : null
}

const NOTE_PREFIX = '> **Dismissed:** '

/**
 * The sticky comment after a dismiss label: the note replaces any earlier note under the
 * heading; when `dismissed`, the heading and outcome line become `defect-dismissed`.
 */
export function dismissComment(
  body: string | null,
  note: string,
  dismissed: boolean,
): string {
  const noteLine = renderDismissNote(note).trimEnd()
  if (body === null) return `${COMMENT_MARKER}\n\n${noteLine}\n`
  const text = body.replace(/\r\n/g, '\n')
  let outcome = outcomeFromComment(text)
  const lines = text.replace(OUTCOME_MARKER, '').split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (line.startsWith(NOTE_PREFIX)) {
      if (kept.at(-1) === '') kept.pop()
      continue
    }
    kept.push(line)
  }
  let heading = kept.findIndex((l) => l.startsWith('## '))
  if (dismissed) {
    outcome = 'defect-dismissed'
    if (heading >= 0) kept[heading] = `## ${verdictLine(outcome)}`
  }
  // No heading (a note-only comment): the note goes right below the marker.
  if (heading < 0) heading = 0
  kept.splice(heading + 1, 0, '', noteLine)
  const out = kept.join('\n')
  return outcome === null ? out : withOutcomeMarker(out, outcome)
}

const HEAD_MARKER = /^<!-- test-agent:head ([0-9a-f]{40}) -->$/

/** Puts the analysed head SHA on the line after the report marker (replacing an earlier one). */
export function withHeadMarker(body: string, headSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(headSha)) return body
  const lines = body.split('\n')
  if (lines[0] !== COMMENT_MARKER) return body
  const marker = `<!-- test-agent:head ${headSha} -->`
  if (HEAD_MARKER.test(lines[1] ?? '')) lines[1] = marker
  else lines.splice(1, 0, marker)
  return lines.join('\n')
}

export function headFromComment(body: string): string | null {
  const line = body.replace(/\r\n/g, '\n').split('\n')[1] ?? ''
  return HEAD_MARKER.exec(line)?.[1] ?? null
}
