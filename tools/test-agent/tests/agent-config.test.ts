import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
)
const claudeDir = path.join(repoRoot, '.claude')

const SKILLS = [
  'analyze-change',
  'derive-test-intent',
  'backend-unit-tests',
  'frontend-unit-tests',
  'run-and-triage',
  'test-report',
]
// Tools that exist in Claude Code 2.1.x and the guard can allow (src/guard.ts). Grep and Glob are
// not tools in this version: listing them only makes the agent call tools that do not exist.
const AGENT_TOOLS = ['Read', 'Edit', 'Write', 'Skill', 'Bash']

function frontmatter(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) throw new Error(`no frontmatter in ${file}`)
  const out: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

describe('unit-test-agent definition', () => {
  const agent = frontmatter(path.join(claudeDir, 'agents/unit-test-agent.md'))

  it('has the expected name, model and description', () => {
    expect(agent.name).toBe('unit-test-agent')
    expect(agent.model).toBe('inherit')
    expect(agent.description.length).toBeGreaterThan(40)
  })

  it('lists exactly the available, guard-allowed tools', () => {
    const tools = agent.tools.split(',').map((t) => t.trim())
    expect(tools).toEqual(AGENT_TOOLS)
  })
})

describe('skills', () => {
  it.each(SKILLS)(
    '%s has a name matching its directory and a description',
    (skill) => {
      const file = path.join(claudeDir, 'skills', skill, 'SKILL.md')
      expect(existsSync(file)).toBe(true)
      const fm = frontmatter(file)
      expect(fm.name).toBe(skill)
      expect(fm.description.length).toBeGreaterThan(40)
    },
  )

  it('stack skills ship references taken from this repository', () => {
    for (const ref of [
      'backend-unit-tests/references/router.md',
      'backend-unit-tests/references/repository.md',
      'frontend-unit-tests/references/component.md',
      'frontend-unit-tests/references/hook.md',
    ])
      expect(existsSync(path.join(claudeDir, 'skills', ref))).toBe(true)
  })
})

describe('explicit settings', () => {
  const settings = JSON.parse(
    readFileSync(path.join(claudeDir, 'test-agent.settings.json'), 'utf8'),
  )

  it('allows only the agent tools and the runner', () => {
    expect(settings.permissions.allow).toEqual([
      'Read',
      'Edit',
      'Write',
      'Skill',
      'Bash(test-agent-run:*)',
    ])
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch']),
    )
  })

  it('runs the guard on every tool call', () => {
    const pre = settings.hooks.PreToolUse
    expect(pre).toHaveLength(1)
    expect(pre[0].matcher).toBe('*')
    expect(pre[0].hooks).toHaveLength(1)
    expect(pre[0].hooks[0].type).toBe('command')
    expect(pre[0].hooks[0].command).toContain(
      'tools/test-agent/src/cli/guard.ts',
    )
  })
})
