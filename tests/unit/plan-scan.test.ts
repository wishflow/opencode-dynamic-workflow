import { describe, expect, it } from "vitest"

import { scanWorkerCalls } from "../../src/script/plan.ts"

/**
 * The scan is the part of `odw_plan` whose failure mode is a **false pass**: it
 * says a typo is fine, and the run then fails after spending money. So the tests
 * here are mostly about what must NOT be reported as a validated call site.
 */
describe("scanWorkerCalls", () => {
  it("reads the literal fields of a single call site", () => {
    const source = `async (ctx) => ctx.agent({ prompt: "hi", agent: "explore", model: "p/m#high", mode: "agentic", permissions: "read-only" })`
    const sites = scanWorkerCalls(source)
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({
      primitive: "ctx.agent",
      dynamic: false,
      agent: "explore",
      model: "p/m#high",
      mode: "agentic",
      permissions: "read-only",
    })
  })

  it("does not mistake a concatenated non-sensitive value for a shorthand property", () => {
    // Regression: `label: "a" + item` used to mark the whole site dynamic, which
    // made the planner skip a literal `agent` typo in the very same object.
    const sites = scanWorkerCalls(`ctx.agent({ label: "read:" + item, prompt: "Read " + item, agent: "explor" })`)
    expect(sites).toHaveLength(1)
    expect(sites[0]?.dynamic).toBe(false)
    expect(sites[0]?.agent).toBe("explor")
  })

  it("still validates a literal field that follows a computed one", () => {
    const sites = scanWorkerCalls(`ctx.agent({ prompt: buildPrompt(x), model: "nope/nope" })`)
    expect(sites[0]?.dynamic).toBe(false)
    expect(sites[0]?.model).toBe("nope/nope")
  })

  it("does not validate a literal that is only the prefix of a concatenation", () => {
    const sites = scanWorkerCalls(`ctx.agent({ prompt: "x", agent: "explore" + suffix })`)
    expect(sites[0]?.dynamic).toBe(true)
    expect(sites[0]?.agent).toBeUndefined()
  })

  it("does not validate a nested object's keys (schema is not an option)", () => {
    const source = `ctx.agent({ prompt: "x", schema: { type: "object", properties: { mode: { type: "string" }, agent: { type: "string" } } } })`
    const sites = scanWorkerCalls(source)
    expect(sites).toHaveLength(1)
    expect(sites[0]?.mode).toBeUndefined()
    expect(sites[0]?.agent).toBeUndefined()
    expect(sites[0]?.dynamic).toBe(false)
  })

  it("marks a non-literal sensitive field as dynamic instead of guessing", () => {
    const sites = scanWorkerCalls(`ctx.agent({ prompt: "x", agent: chosenAgent })`)
    expect(sites).toHaveLength(1)
    expect(sites[0]?.dynamic).toBe(true)
    expect(sites[0]?.agent).toBeUndefined()
  })

  it("marks a spread in the options object as dynamic", () => {
    const sites = scanWorkerCalls(`ctx.agent({ prompt: "x", ...extra })`)
    expect(sites[0]?.dynamic).toBe(true)
  })

  it("ignores occurrences inside strings and comments", () => {
    const source = [
      `// ctx.agent({ agent: "not-real" })`,
      `/* ctx.agent({ model: "also/not-real" }) */`,
      `const note = "call ctx.agent({ agent: 'nope' }) to do it"`,
      `ctx.agent({ prompt: "real" })`,
    ].join("\n")
    const sites = scanWorkerCalls(source)
    expect(sites).toHaveLength(1)
    expect(sites[0]?.agent).toBeUndefined()
    expect(sites[0]?.line).toBe(4)
  })

  it("does not match an identifier that merely starts with the primitive name", () => {
    expect(scanWorkerCalls(`ctx.agentFoo({})`)).toHaveLength(0)
  })

  it("finds ctx.verify and treats a string argument as dynamic", () => {
    const sites = scanWorkerCalls(`ctx.verify("the file compiles")`)
    expect(sites).toHaveLength(1)
    expect(sites[0]?.primitive).toBe("ctx.verify")
    expect(sites[0]?.dynamic).toBe(true)
  })

  it("reads ctx.verify's options object", () => {
    const sites = scanWorkerCalls(`ctx.verify({ claim: "c", permissions: "inherit", agent: "general" })`)
    expect(sites[0]).toMatchObject({ primitive: "ctx.verify", dynamic: false, permissions: "inherit", agent: "general" })
  })

  it("reports the 1-based line of each call site, including across newlines", () => {
    const source = ["async (ctx) => {", "  const a = await ctx.agent({", '    prompt: "a",', "  })", "  return ctx.agent({ prompt: 'b' })", "}"].join("\n")
    const sites = scanWorkerCalls(source)
    expect(sites.map((site) => site.line)).toEqual([2, 5])
  })

  it("handles a prompt string containing a closing paren and a comma", () => {
    const sites = scanWorkerCalls(`ctx.agent({ prompt: "say (this, ok)", agent: "build" })`)
    expect(sites).toHaveLength(1)
    expect(sites[0]?.agent).toBe("build")
  })

  it("preserves a literal exactly, so a typo like a trailing space stays visible", () => {
    const sites = scanWorkerCalls(`ctx.agent({ prompt: "x", agent: "explore " })`)
    expect(sites[0]?.agent).toBe("explore ")
  })

  it("returns nothing for a script with no worker calls", () => {
    expect(scanWorkerCalls(`async (ctx) => { ctx.log("nothing to do"); return 1 }`)).toHaveLength(0)
  })
})
