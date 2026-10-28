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

const LEADING_EXPORT_DEFAULT = /^\s*export\s+default\s+/

export function normalizeScript(raw: string): string {
  let source = raw.trim()
  if (source === "") {
    throw new SyntaxError("workflow 脚本为空")
  }
  source = source.replace(LEADING_EXPORT_DEFAULT, "").trim()
  source = stripTrailingSemicolons(source)
  return source
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
