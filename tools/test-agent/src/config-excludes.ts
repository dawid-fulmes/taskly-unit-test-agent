import ts from 'typescript'

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p)) return null
  const n = p.name
  return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null
}

/** Returns the string literals of `coverage.exclude` in a vitest/vite config; throws if absent or not an array of string literals. */
export function readCoverageExcludes(source: string): string[] {
  const sf = ts.createSourceFile(
    'config.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  let found: ts.Expression | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      propName(node) === 'coverage' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (propName(p) === 'exclude' && ts.isPropertyAssignment(p))
          found = p.initializer
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const expr = found as ts.Expression | null
  if (expr === null || !ts.isArrayLiteralExpression(expr))
    throw new Error('coverage.exclude is not an array literal')
  return expr.elements.map((e) => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
      return e.text
    throw new Error('coverage.exclude contains a non-string-literal element')
  })
}
