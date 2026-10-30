export interface FileDiff {
  oldPath: string | null
  newPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  binary: boolean
  /** Mode after the change (`new file mode` / `new mode`), null when unchanged. */
  newMode: string | null
  /** Mode before the change (`deleted file mode` / `old mode`), null when unknown. */
  oldMode: string | null
  /** True when the `diff --git` line disagrees with the ---/+++ or rename headers. */
  headerMismatch: boolean
  /** Set when the section is not strictly well-formed git diff text (git apply could read more than we do). */
  malformed: string | null
  added: { line: number; text: string }[]
  removed: { line: number; text: string }[]
}

export interface DiffSection {
  /** Raw text of the section, including the trailing newline when present. */
  raw: string
  /** Header lines (everything before the first hunk). */
  header: string[]
}

const GIT_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '"': 34,
  '\\': 92,
}

/** Unquote a git C-style quoted path (`"a/caf\303\251"`). Returns null if malformed. */
function unquoteGit(quoted: string): string | null {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"'))
    return null
  const body = quoted.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '"') return null
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = body[++i]
    if (next === undefined) return null
    if (/[0-7]/.test(next)) {
      let oct = next
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i]
      bytes.push(parseInt(oct, 8) & 0xff)
    } else if (next in GIT_ESCAPES) {
      bytes.push(GIT_ESCAPES[next]!)
    } else {
      return null
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Read a possibly-quoted name; unquoted names run to end of string (trailing tab stripped). */
function readName(raw: string): string | null {
  if (raw.startsWith('"')) return unquoteGit(raw.replace(/\t$/, ''))
  return raw.replace(/\t$/, '')
}

/** Strip the mandatory `a/` / `b/` prefix; null when missing (git apply -p1 would eat a real component). */
function stripPrefix(name: string, prefix: 'a/' | 'b/'): string | null {
  return name.startsWith(prefix) ? name.slice(2) : null
}

/** Parse `diff --git a/<x> b/<y>`; null when ambiguous, malformed or a/ b/ prefixes are missing. */
function parseGitLine(line: string): { a: string; b: string } | null {
  const rest = line.slice('diff --git '.length)
  let rawA: string | null
  let rawB: string | null
  if (rest.startsWith('"')) {
    let i = 1
    while (i < rest.length && rest[i] !== '"') i += rest[i] === '\\' ? 2 : 1
    rawA = unquoteGit(rest.slice(0, i + 1))
    if (rest[i + 1] !== ' ') return null
    rawB = readName(rest.slice(i + 2))
  } else if (rest.includes(' "')) {
    const idx = rest.indexOf(' "')
    rawA = rest.slice(0, idx)
    rawB = unquoteGit(rest.slice(idx + 1))
  } else if (rest.startsWith('a/') && (rest.length - 5) % 2 === 0) {
    // Non-renames have equal halves, which pins the split.
    const half = (rest.length - 5) / 2
    const x = rest.slice(2, 2 + half)
    if (rest === `a/${x} b/${x}`) return { a: x, b: x }
    const idx = rest.indexOf(' b/')
    if (idx < 0) return null
    rawA = rest.slice(0, idx)
    rawB = rest.slice(idx + 1)
  } else {
    const idx = rest.indexOf(' b/')
    if (idx < 0) return null
    rawA = rest.slice(0, idx)
    rawB = rest.slice(idx + 1)
  }
  if (rawA === null || rawB === null) return null
  const a = stripPrefix(rawA, 'a/')
  const b = stripPrefix(rawB, 'b/')
  return a === null || b === null ? null : { a, b }
}

export function splitSections(text: string): {
  preamble: string
  sections: DiffSection[]
} {
  // Split on \n only (git does); never rely on JS `^`/`m` semantics, which also break on \r, U+2028/9.
  const starts: number[] = []
  for (let pos = 0; pos < text.length;) {
    if (text.startsWith('diff --git ', pos)) starts.push(pos)
    const nl = text.indexOf('\n', pos)
    if (nl < 0) break
    pos = nl + 1
  }
  const preamble = text.slice(0, starts[0] ?? text.length)
  const sections = starts.map((s, i) => {
    const raw = text.slice(s, starts[i + 1] ?? text.length)
    const lines = raw.split('\n')
    const hunk = lines.findIndex((l) => l.startsWith('@@'))
    return { raw, header: hunk < 0 ? lines : lines.slice(0, hunk) }
  })
  return { preamble, sections }
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const KNOWN_HEADER =
  /^(index |similarity index |dissimilarity index |old mode |new mode |new file mode |deleted file mode |rename from |rename to |copy from |copy to |--- |\+\+\+ |Binary files )/

/**
 * Strict hunk parser driven by the @@ counts. After a hunk's counts are consumed only
 * another hunk, a `\ No newline` marker, or the end of the section may follow.
 */
function parseHunks(
  lines: string[],
  added: FileDiff['added'],
  removed: FileDiff['removed'],
): string | null {
  let i = 0
  while (i < lines.length) {
    const m = HUNK.exec(lines[i]!)
    if (!m)
      return `unexpected content after hunk: ${JSON.stringify(lines[i]!.slice(0, 80))}`
    let oldLeft = m[2] === undefined ? 1 : Number(m[2])
    let newLeft = m[4] === undefined ? 1 : Number(m[4])
    let oldLn = Number(m[1])
    let newLn = Number(m[3])
    i++
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[i]
      if (line === undefined) return 'hunk shorter than its @@ counts'
      i++
      const c = line[0]
      if (c === '\\') continue
      if (c === '+' && newLeft > 0) {
        added.push({ line: newLn++, text: line.slice(1) })
        newLeft--
      } else if (c === '-' && oldLeft > 0) {
        removed.push({ line: oldLn++, text: line.slice(1) })
        oldLeft--
      } else if ((c === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        oldLn++
        newLn++
        oldLeft--
        newLeft--
      } else
        return `hunk line inconsistent with @@ counts: ${JSON.stringify(line.slice(0, 80))}`
    }
    while (lines[i]?.startsWith('\\')) i++
  }
  return null
}

function parseSection(section: DiffSection): FileDiff {
  const header = section.header
  const git = parseGitLine(header[0]!)
  let malformed: string | null = git
    ? null
    : 'diff --git line is unparseable or lacks a/ b/ prefixes'
  let renameFrom: string | null = null
  let renameTo: string | null = null
  let copied = false
  let minus: string | null | undefined
  let plus: string | null | undefined
  let newFileMode: string | null = null
  let deletedFileMode: string | null = null
  let oldMode: string | null = null
  let newMode: string | null = null
  let binary = false

  const bad = (why: string) => {
    malformed ??= why
  }
  const side = (
    raw: string,
    prefix: 'a/' | 'b/',
  ): string | null | undefined => {
    const n = readName(raw)
    if (n === '/dev/null') return null
    const stripped = n === null ? null : stripPrefix(n, prefix)
    if (stripped === null) {
      bad(`---/+++ path lacks ${prefix} prefix or is malformed`)
      return undefined
    }
    return stripped
  }

  for (const line of header.slice(1)) {
    let m: RegExpMatchArray | null
    if (binary) continue // binary bodies are rejected wholesale
    if ((m = line.match(/^new file mode (\S+)/))) newFileMode = m[1]!
    else if ((m = line.match(/^deleted file mode (\S+)/)))
      deletedFileMode = m[1]!
    else if ((m = line.match(/^old mode (\S+)/))) oldMode = m[1]!
    else if ((m = line.match(/^new mode (\S+)/))) newMode = m[1]!
    else if (line.startsWith('rename from '))
      renameFrom = readName(line.slice(12))
    else if (line.startsWith('rename to ')) renameTo = readName(line.slice(10))
    else if (line.startsWith('copy from ')) {
      copied = true
      renameFrom = readName(line.slice(10))
    } else if (line.startsWith('copy to ')) {
      copied = true
      renameTo = readName(line.slice(8))
    } else if (line.startsWith('--- ')) {
      if (minus !== undefined) bad('duplicate --- header')
      minus = side(line.slice(4), 'a/')
    } else if (line.startsWith('+++ ')) {
      if (plus !== undefined) bad('duplicate +++ header')
      plus = side(line.slice(4), 'b/')
    } else if (
      /^Binary files .* differ$/.test(line) ||
      line === 'GIT binary patch'
    )
      binary = true
    else if (line !== '' && !KNOWN_HEADER.test(line))
      bad(`unrecognised header line: ${JSON.stringify(line.slice(0, 80))}`)
  }

  let oldPath: string | null
  let newPath: string | null
  if (renameFrom !== null || renameTo !== null) {
    oldPath = renameFrom
    newPath = renameTo
  } else {
    oldPath = minus !== undefined ? minus : (git?.a ?? null)
    newPath = plus !== undefined ? plus : (git?.b ?? null)
  }

  let status: FileDiff['status'] = 'modified'
  if (renameFrom !== null || renameTo !== null || copied) status = 'renamed'
  else if (newFileMode !== null || minus === null) status = 'added'
  else if (deletedFileMode !== null || plus === null) status = 'deleted'
  else if (oldPath !== null && newPath !== null && oldPath !== newPath)
    status = 'renamed'
  if (status === 'added') oldPath = null
  if (status === 'deleted') newPath = null

  const headerMismatch =
    git !== null &&
    status !== 'renamed' &&
    (git.a !== git.b ||
      (oldPath !== null && git.a !== oldPath) ||
      (newPath !== null && git.b !== newPath))

  const added: FileDiff['added'] = []
  const removed: FileDiff['removed'] = []
  if (!binary) {
    const lines = section.raw.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const err = parseHunks(lines.slice(header.length), added, removed)
    if (err) bad(err)
  }

  return {
    oldPath,
    newPath,
    status,
    binary,
    newMode: newFileMode ?? newMode,
    oldMode: deletedFileMode ?? oldMode,
    headerMismatch,
    malformed,
    added,
    removed,
  }
}

const LINE_TERMINATORS = /[\r\u2028\u2029]/

function pseudo(malformed: string): FileDiff {
  return {
    oldPath: null,
    newPath: null,
    status: 'modified',
    binary: false,
    newMode: null,
    oldMode: null,
    headerMismatch: false,
    malformed,
    added: [],
    removed: [],
  }
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const { preamble, sections } = splitSections(text)
  const out = sections.map(parseSection)

  // A path may appear in only one section, so a construct cannot be split across sections.
  const seen = new Set<string>()
  for (const d of out) {
    const mine = new Set([d.oldPath, d.newPath])
    for (const p of mine) {
      if (p === null) continue
      if (seen.has(p))
        d.malformed ??= `path appears in more than one section: ${p}`
    }
    for (const p of mine) if (p !== null) seen.add(p)
  }

  if (preamble.trim() !== '')
    out.unshift(
      pseudo(
        `unparsed content before the first diff --git: ${JSON.stringify(preamble.trim().slice(0, 80))}`,
      ),
    )
  if (LINE_TERMINATORS.test(text))
    out.unshift(pseudo('line terminator not allowed (CR, U+2028 or U+2029)'))
  return out
}

/** New-file line numbers of added lines. */
export function changedLines(d: FileDiff): number[] {
  return d.added.map((l) => l.line)
}
