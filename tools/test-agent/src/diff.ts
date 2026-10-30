import parseDiff from 'parse-diff'

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

function stripPrefix(name: string, prefix: 'a/' | 'b/'): string {
  return name.startsWith(prefix) ? name.slice(2) : name
}

/** Parse `diff --git <a> <b>`; null when ambiguous or malformed. */
function parseGitLine(line: string): { a: string; b: string } | null {
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('"')) {
    // Quoted first name: find its closing quote.
    let i = 1
    while (i < rest.length && rest[i] !== '"') i += rest[i] === '\\' ? 2 : 1
    const a = unquoteGit(rest.slice(0, i + 1))
    const b = readName(rest.slice(i + 2))
    if (a === null || b === null) return null
    return { a: stripPrefix(a, 'a/'), b: stripPrefix(b, 'b/') }
  }
  if (rest.includes('"')) {
    // Unquoted first, quoted second.
    const idx = rest.indexOf(' "')
    if (idx < 0) return null
    const a = rest.slice(0, idx)
    const b = unquoteGit(rest.slice(idx + 1))
    if (b === null) return null
    return { a: stripPrefix(a, 'a/'), b: stripPrefix(b, 'b/') }
  }
  // Both unquoted: for non-renames the halves are equal, which pins the split.
  if (rest.startsWith('a/') && (rest.length - 5) % 2 === 0) {
    const half = (rest.length - 5) / 2
    const x = rest.slice(2, 2 + half)
    if (rest === `a/${x} b/${x}`) return { a: x, b: x }
  }
  const idx = rest.indexOf(' b/')
  if (idx < 0) return null
  return { a: stripPrefix(rest.slice(0, idx), 'a/'), b: rest.slice(idx + 3) }
}

export function splitSections(text: string): {
  preamble: string
  sections: DiffSection[]
} {
  const starts: number[] = []
  const re = /^diff --git /gm
  for (let m = re.exec(text); m; m = re.exec(text)) starts.push(m.index)
  const preamble = text.slice(0, starts[0] ?? text.length)
  const sections = starts.map((s, i) => {
    const raw = text.slice(s, starts[i + 1] ?? text.length)
    const lines = raw.split('\n')
    const hunk = lines.findIndex((l) => l.startsWith('@@'))
    return { raw, header: hunk < 0 ? lines : lines.slice(0, hunk) }
  })
  return { preamble, sections }
}

function parseSection(section: DiffSection): FileDiff {
  const header = section.header
  const git = parseGitLine(header[0]!)
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

  for (const line of header.slice(1)) {
    let m: RegExpMatchArray | null
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
      const n = readName(line.slice(4))
      minus = n === '/dev/null' ? null : n === null ? n : stripPrefix(n, 'a/')
    } else if (line.startsWith('+++ ')) {
      const n = readName(line.slice(4))
      plus = n === '/dev/null' ? null : n === null ? n : stripPrefix(n, 'b/')
    } else if (
      /^Binary files .* differ$/.test(line) ||
      line === 'GIT binary patch'
    )
      binary = true
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
    // Feed parse-diff only the hunks; it needs ---/+++ to open a file block.
    const hunkText = section.raw.slice(section.raw.indexOf('\n@@') + 1)
    if (section.raw.includes('\n@@')) {
      const parsed = parseDiff(`--- a/x\n+++ b/x\n${hunkText}`)
      for (const f of parsed)
        for (const chunk of f.chunks)
          for (const c of chunk.changes) {
            if (c.type === 'add')
              added.push({ line: c.ln, text: c.content.slice(1) })
            else if (c.type === 'del')
              removed.push({ line: c.ln, text: c.content.slice(1) })
          }
    }
  }

  return {
    oldPath,
    newPath,
    status,
    binary,
    newMode: newFileMode ?? newMode,
    oldMode: deletedFileMode ?? oldMode,
    headerMismatch,
    added,
    removed,
  }
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  return splitSections(text).sections.map(parseSection)
}

/** New-file line numbers of added lines. */
export function changedLines(d: FileDiff): number[] {
  return d.added.map((l) => l.line)
}
