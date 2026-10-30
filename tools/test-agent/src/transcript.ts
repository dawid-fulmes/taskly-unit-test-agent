export interface TranscriptSummary {
  skills: string[]
  toolUseIds: string[]
  costUsd: number | null
  turns: number | null
  stop: 'success' | 'max-turns' | 'max-budget' | 'error' | 'unknown'
  invalidLines: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function parseLines(jsonl: string): { objs: Obj[]; invalid: number } {
  const objs: Obj[] = []
  let invalid = 0
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      const v: unknown = JSON.parse(line)
      if (isObj(v)) objs.push(v)
      else invalid++
    } catch {
      invalid++
    }
  }
  return { objs, invalid }
}

function mapStop(
  subtype: unknown,
  isError: unknown,
): TranscriptSummary['stop'] {
  if (isError === true) return 'error'
  if (typeof subtype !== 'string') return 'unknown'
  if (subtype === 'success') return 'success'
  if (subtype.includes('budget')) return 'max-budget'
  if (subtype === 'error_max_turns') return 'max-turns'
  if (subtype.startsWith('error')) return 'error'
  return 'unknown'
}

const finite = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

/** Derives run facts from Claude Code `--output-format stream-json --verbose` output; never trusts the report. */
export function summarizeTranscript(jsonl: string): TranscriptSummary {
  const { objs, invalid } = parseLines(jsonl)
  const skills: string[] = []
  const toolUseIds: string[] = []
  const seenIds = new Set<string>()
  const failed = new Set<string>()
  const skillCalls: { id: string; skill: string }[] = []
  let result: Obj | null = null
  for (const o of objs) {
    if (o.type === 'result') result = o // last result line wins
    const content = isObj(o.message) ? o.message.content : undefined
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (!isObj(b)) continue
      if (b.type === 'tool_result') {
        if (b.is_error === true && typeof b.tool_use_id === 'string')
          failed.add(b.tool_use_id)
        continue
      }
      if (b.type !== 'tool_use') continue
      const id = typeof b.id === 'string' ? b.id : ''
      if (id && !seenIds.has(id)) {
        seenIds.add(id)
        toolUseIds.push(id)
      }
      if (b.name === 'Skill' && isObj(b.input)) {
        const s = b.input.skill
        if (typeof s === 'string' && s) skillCalls.push({ id, skill: s })
      }
    }
  }
  for (const c of skillCalls)
    if (!failed.has(c.id) && !skills.includes(c.skill)) skills.push(c.skill)
  return {
    skills,
    toolUseIds,
    costUsd: result ? finite(result.total_cost_usd) : null,
    turns: result ? finite(result.num_turns) : null,
    stop: result ? mapStop(result.subtype, result.is_error) : 'unknown',
    invalidLines: invalid,
  }
}

/** Tool-use ids that have no record in the guard log (JSONL; malformed lines ignored). */
export function guardCoverage(
  toolUseIds: string[],
  guardLogJsonl: string,
): string[] {
  const seen = new Set<string>()
  for (const o of parseLines(guardLogJsonl).objs)
    if (typeof o.tool_use_id === 'string') seen.add(o.tool_use_id)
  return toolUseIds.filter((id) => !seen.has(id))
}
