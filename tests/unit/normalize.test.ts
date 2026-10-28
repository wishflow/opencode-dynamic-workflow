import { describe, expect, it } from "vitest"

import { asCallableExpression, normalizeScript } from "../../src/script/normalize.ts"

/**
 * `normalizeScript` is what lets the model write the natural forms. Each case
 * here is a shape a real model actually emitted; the failure mode when one is
 * missed is a cryptic `SyntaxError` from inside the sandbox.
 */
describe("normalizeScript", () => {
  it("strips a plain `export default`", () => {
    expect(normalizeScript("export default async (ctx) => 1")).toBe("async (ctx) => 1")
  })

  it("strips `export default` written after a leading line comment", () => {
    const source = "// audit the repo\nexport default async (ctx) => 1"
    expect(normalizeScript(source)).toBe("async (ctx) => 1")
  })

  it("strips `export default` written after a leading block comment", () => {
    const source = "/** audit the repo */\nexport default async (ctx) => 1"
    expect(normalizeScript(source)).toBe("async (ctx) => 1")
  })

  it("survives a multi-line header comment and blank lines (the `workflows/*.ts` shape)", () => {
    const source = [
      "/**",
      " * Example workflow: audit a few files.",
      " * Run with odw_run({ file: 'audit.ts' }).",
      " */",
      "",
      "export default async (ctx) => {",
      "  return await ctx.phase('audit')",
      "}",
    ].join("\n")
    const normalized = normalizeScript(source)
    expect(normalized.startsWith("async (ctx) => {")).toBe(true)
    expect(normalized).not.toContain("export default")
  })

  it("leaves an arrow function without `export default` untouched", () => {
    expect(normalizeScript("async (ctx) => 1")).toBe("async (ctx) => 1")
  })

  it("accepts a function declaration form", () => {
    expect(normalizeScript("async function workflow(ctx) { return 1 }")).toBe(
      "async function workflow(ctx) { return 1 }",
    )
  })

  it("keeps a leading comment when there is nothing to strip", () => {
    expect(normalizeScript("/* note */ async (ctx) => 1")).toBe("/* note */ async (ctx) => 1")
  })

  it("does not treat a leading regex literal as a comment", () => {
    const source = "async (ctx) => /a/.test('a')"
    expect(normalizeScript(source)).toBe(source)
  })

  it("drops trailing semicolons", () => {
    expect(normalizeScript("export default async (ctx) => 1;;;")).toBe("async (ctx) => 1")
  })

  it("rejects an empty script", () => {
    expect(() => normalizeScript("   \n  ")).toThrow(SyntaxError)
  })

  it("wraps the result so evaluating it yields a callable value", () => {
    const wrapped = asCallableExpression(normalizeScript("export default async (ctx) => 1"))
    expect(wrapped).toBe("(async (ctx) => 1)")
  })

  it("produces source that is valid inside a parenthesised expression", () => {
    // The real failure this guards: `(/* c */ export default ...)` is a SyntaxError.
    const normalized = normalizeScript("/** header */\nexport default async (ctx) => 1")
    expect(asCallableExpression(normalized)).toBe("(async (ctx) => 1)")
  })
})
