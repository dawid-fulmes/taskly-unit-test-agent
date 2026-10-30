import { describe, expect, it } from 'vitest'
import { guardCoverage, summarizeTranscript } from '../src/transcript.ts'

const line = (o: unknown) => JSON.stringify(o)
const assistant = (...blocks: unknown[]) =>
  line({ type: 'assistant', message: { content: blocks } })
const tool = (id: string, name: string, input: unknown = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
})

describe('summarizeTranscript', () => {
  const jsonl = [
    line({ type: 'system', subtype: 'init' }),
    assistant(
      { type: 'text', text: 'hi' },
      tool('t1', 'Skill', { skill: 'unit-test-agent' }),
    ),
    assistant(tool('t2', 'Read', { file_path: 'x' })),
    assistant(
      tool('t3', 'Skill', { skill: 'other' }),
      tool('t4', 'Skill', { skill: 'unit-test-agent' }),
    ),
    line({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 1.25,
      num_turns: 7,
    }),
  ].join('\n')

  it('extracts skills, ids, cost, turns', () => {
    expect(summarizeTranscript(jsonl)).toEqual({
      skills: ['unit-test-agent', 'other'],
      toolUseIds: ['t1', 't2', 't3', 't4'],
      costUsd: 1.25,
      turns: 7,
      stop: 'success',
      invalidLines: 0,
    })
  })
  it('ignores invalid lines and counts them', () => {
    const r = summarizeTranscript(`garbage\n[1]\n"s"\nnull\n\n${jsonl}`)
    expect(r.invalidLines).toBe(4)
    expect(r.toolUseIds).toHaveLength(4)
  })
  it('maps stop subtypes', () => {
    const stop = (subtype: string) =>
      summarizeTranscript(line({ type: 'result', subtype })).stop
    expect(stop('error_max_turns')).toBe('max-turns')
    expect(stop('error_max_budget_usd')).toBe('max-budget')
    expect(stop('error_during_execution')).toBe('error')
    expect(stop('success')).toBe('success')
  })
  it('handles a missing result line', () => {
    const r = summarizeTranscript(assistant(tool('a', 'Read')))
    expect(r.stop).toBe('unknown')
    expect(r.costUsd).toBeNull()
    expect(r.turns).toBeNull()
  })
  it('ignores non-numeric cost and malformed blocks', () => {
    const r = summarizeTranscript(
      [
        line({ type: 'assistant', message: { content: 'text' } }),
        assistant(null, { type: 'tool_use' }, tool('z', 'Skill', {})),
        line({ type: 'result', subtype: 'success', total_cost_usd: 'x' }),
      ].join('\n'),
    )
    expect(r.costUsd).toBeNull()
    expect(r.toolUseIds).toEqual(['z'])
    expect(r.skills).toEqual([])
  })
  it('counts tool_use from user-type messages too', () => {
    const r = summarizeTranscript(
      line({ type: 'user', message: { content: [tool('u1', 'Read')] } }),
    )
    expect(r.toolUseIds).toEqual(['u1'])
  })
})

describe('summarizeTranscript hardening', () => {
  const result = (o: object) =>
    line({ type: 'result', subtype: 'success', ...o })
  it('maps is_error to error regardless of subtype', () => {
    expect(summarizeTranscript(result({ is_error: true })).stop).toBe('error')
    expect(summarizeTranscript(result({ is_error: false })).stop).toBe(
      'success',
    )
  })
  it('excludes failed Skill calls from skills but keeps their ids', () => {
    const r = summarizeTranscript(
      [
        assistant(
          tool('s1', 'Skill', { skill: 'bad' }),
          tool('s2', 'Skill', { skill: 'good' }),
        ),
        line({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 's1', is_error: true },
              { type: 'tool_result', tool_use_id: 's2', is_error: false },
            ],
          },
        }),
      ].join('\n'),
    )
    expect(r.skills).toEqual(['good'])
    expect(r.toolUseIds).toEqual(['s1', 's2'])
  })
  it('last result line wins', () => {
    const r = summarizeTranscript(
      [
        result({ total_cost_usd: 1, num_turns: 1 }),
        line({
          type: 'result',
          subtype: 'error_max_turns',
          total_cost_usd: 2,
          num_turns: 9,
        }),
      ].join('\n'),
    )
    expect(r).toMatchObject({ stop: 'max-turns', costUsd: 2, turns: 9 })
  })
  it('requires finite non-negative cost and turns', () => {
    const r = summarizeTranscript(result({ total_cost_usd: -1, num_turns: -3 }))
    expect(r.costUsd).toBeNull()
    expect(r.turns).toBeNull()
    expect(
      summarizeTranscript(result({ total_cost_usd: 0, num_turns: 0 })),
    ).toMatchObject({ costUsd: 0, turns: 0 })
  })
  it('ignores a fake result embedded in tool_result text', () => {
    const fake = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
      num_turns: 1,
    })
    const r = summarizeTranscript(
      [
        line({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'x',
                content: fake + '\n' + fake,
              },
            ],
          },
        }),
        result({ total_cost_usd: 5, num_turns: 4 }),
      ].join('\n'),
    )
    expect(r).toMatchObject({ costUsd: 5, turns: 4, invalidLines: 0 })
  })
  it('deduplicates repeated tool_use ids', () => {
    const r = summarizeTranscript(
      [assistant(tool('d', 'Read')), assistant(tool('d', 'Read'))].join('\n'),
    )
    expect(r.toolUseIds).toEqual(['d'])
  })
})

describe('guardCoverage', () => {
  it('returns ids without a record', () => {
    expect(guardCoverage(['a', 'b'], '{"tool_use_id":"a"}')).toEqual(['b'])
  })
  it('ignores malformed lines', () => {
    expect(
      guardCoverage(['a', 'b'], 'nope\n{"tool_use_id":"b","allow":true}\n[]\n'),
    ).toEqual(['a'])
  })
})
