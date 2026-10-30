import { describe, expect, it } from 'vitest'
import { quoteInDescription, resolvePointer } from '../src/citations.ts'

const doc = {
  paths: { '/api/todos': { get: { responses: { '422': {} } } } },
  list: ['a', 'b'],
  'a~b': 1,
}

describe('resolvePointer', () => {
  it('resolves escaped pointers', () => {
    expect(resolvePointer(doc, '/paths/~1api~1todos/get/responses/422')).toBe(
      true,
    )
    expect(resolvePointer(doc, '/a~0b')).toBe(true)
    expect(resolvePointer(doc, '')).toBe(true)
    expect(resolvePointer(doc, '/list/1')).toBe(true)
  })
  it('rejects missing targets', () => {
    expect(resolvePointer(doc, '/paths/~1api~1todos/get/responses/400')).toBe(
      false,
    )
    expect(resolvePointer(doc, '/list/2')).toBe(false)
  })
  it('returns false for malformed pointers', () => {
    expect(resolvePointer(doc, 'paths')).toBe(false)
    expect(resolvePointer(doc, '/a~2b')).toBe(false)
    expect(resolvePointer(doc, '/a~')).toBe(false)
    expect(resolvePointer(doc, '/list/01')).toBe(false)
    expect(resolvePointer(doc, '/list/x')).toBe(false)
    expect(resolvePointer(doc, '/list/-1')).toBe(false)
    expect(resolvePointer(doc, '/list/-')).toBe(false)
  })
  it('uses own-property lookups only', () => {
    expect(resolvePointer(doc, '/__proto__')).toBe(false)
    expect(resolvePointer(doc, '/constructor')).toBe(false)
    expect(resolvePointer(doc, '/paths/constructor/prototype')).toBe(false)
    expect(resolvePointer(doc, '/list/length')).toBe(false)
    expect(resolvePointer(doc, '/paths/toString')).toBe(false)
  })
  it('handles non-container docs', () => {
    expect(resolvePointer(null, '/a')).toBe(false)
    expect(resolvePointer('x', '/0')).toBe(false)
  })
})

describe('quoteInDescription', () => {
  const body = 'Line one\nThe API must return 422 on empty title.\nEnd'
  it('matches across CRLF', () => {
    expect(
      quoteInDescription(
        'Line one\r\nThe API must return 422',
        body.replace(/\n/g, '\r\n'),
      ),
    ).toBe(true)
    expect(quoteInDescription('Line one\r\nThe API must return', body)).toBe(
      true,
    )
  })
  it('rejects short quotes', () => {
    expect(quoteInDescription('Line', body)).toBe(false)
    expect(quoteInDescription('   Line one   ', body)).toBe(false)
    expect(quoteInDescription('', body)).toBe(false)
  })
  it('requires 10 non-whitespace chars and an alphanumeric', () => {
    expect(quoteInDescription('----------', 'x ---------- y')).toBe(false)
    expect(quoteInDescription('a b c d e f', 'a b c d e f')).toBe(false)
    expect(quoteInDescription('abcde fghij', 'abcde fghij')).toBe(true)
  })
  it('trims surrounding whitespace and requires exact match', () => {
    expect(quoteInDescription('  must return 422  \n', body)).toBe(true)
    expect(quoteInDescription('must  return 422', body)).toBe(false)
    expect(quoteInDescription('MUST RETURN 422', body)).toBe(false)
  })
})
