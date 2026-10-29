/**
 * Script source normalization.
 *
 * The model is asked to write "a JS/TS expression that evaluates to an async
 * function taking `ctx`". In practice it emits any of these, and all of them have
 * to work, because the failure mode otherwise is a cryptic SyntaxError:
 *
 *   export default async (ctx) => { ... }
 *   async (ctx) => { ... }
 *   (async (ctx) => { ... })
 *   async function workflow(ctx) { ... }
 *
 * TS type annotations are *not* stripped: opencode's embedded runtime (Bun) parses
 * the source as TS, and the contract suite loads `.ts` plugin sources directly.
 */

const LEADING_EXPORT_DEFAULT = /^export\s+default\s+/

/**
 * Strips `export default` so the source can be wrapped as an expression.
 *
 * The subtlety is that the model (and every human) writes a header comment above
 * the export, and `^\s*export default` does not match past a comment - so a
 * perfectly valid file like
 *
 *   /** audit the repo *\/
 *   export default async (ctx) => {...}
 *
 * would be wrapped as `(/** ... *\/ export default async (ctx) => ...)`, which is
 * a SyntaxError ("export" inside a parenthesized expression). Leading comments
 * are therefore skipped before looking for the keyword.
 */
export function normalizeScript(raw: string): string {
  let source = raw.trim()
  if (source === "") {
    throw new SyntaxError("workflow script is empty")
  }
  const head = skipLeadingComments(source)
  const match = LEADING_EXPORT_DEFAULT.exec(source.slice(head))
  if (match !== null) {
    source = source.slice(head + match[0].length).trim()
  }
  source = stripTrailingSemicolons(source)
  return source
}

/** Index of the first character that is neither whitespace nor a comment. */
function skipLeadingComments(source: string): number {
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c !== undefined && /\s/.test(c)) {
      i += 1
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1
      i = Math.min(source.length, i + 2)
      continue
    }
    break
  }
  return i
}

/**
 * Wraps the normalized source so that evaluating it yields a callable value.
 * `(async (ctx) => {...})` and `(async function workflow(ctx) {...})` are both
 * valid expressions, so one wrapper covers every accepted shape.
 */
export function asCallableExpression(source: string): string {
  return `(${source})`
}

function stripTrailingSemicolons(source: string): string {
  let out = source
  while (out.endsWith(";")) out = out.slice(0, -1).trimEnd()
  return out
}
