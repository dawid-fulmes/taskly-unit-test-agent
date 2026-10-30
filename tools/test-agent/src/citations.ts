const hasOwn = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k)

/** RFC 6901 pointer lookup. Returns false (never throws) for malformed pointers or missing targets. */
export function resolvePointer(doc: unknown, pointer: string): boolean {
  if (typeof pointer !== 'string') return false
  if (pointer === '') return true
  if (!pointer.startsWith('/')) return false
  let cur: unknown = doc
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) return false
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return false
      const i = Number(key)
      if (i >= cur.length) return false
      cur = cur[i]
    } else if (cur !== null && typeof cur === 'object') {
      if (!hasOwn(cur, key)) return false
      cur = (cur as Record<string, unknown>)[key]
    } else {
      return false
    }
  }
  return true
}

const MIN_QUOTE = 10
const norm = (s: string) => s.replace(/\r\n/g, '\n')

/** Verbatim quote check: CRLF-normalised, surrounding whitespace of the quote trimmed, >= 10 chars. */
export function quoteInDescription(quote: string, body: string): boolean {
  if (typeof quote !== 'string' || typeof body !== 'string') return false
  const q = norm(quote).trim()
  if (q.replace(/\s/gu, '').length < MIN_QUOTE) return false
  if (!/[\p{L}\p{N}]/u.test(q)) return false
  return norm(body).includes(q)
}
