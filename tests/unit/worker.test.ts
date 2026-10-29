import { describe, expect, it } from "vitest"

import { OdwError } from "../../src/types.ts"
import { resolveMode, resolveWorkerModel, type WorkerDeps } from "../../src/worker/agentic.ts"
import {
  buildOneshotPrompt,
  buildWorkerPrompt,
  describePermissions,
  resolvePermissions,
  DENY_ALL_RULES,
  READ_ONLY_RULES,
} from "../../src/worker/lifecycle.ts"

/**
 * `resolveWorkerModel` is the last gate before a `session.create`, so what it
 * rejects is a worker that was never created and never billed. `resolveMode` and
 * the permission/prompt helpers are here for the same reason: a mistake in the
 * oneshot posture would silently give a "no tools" worker the full tool set.
 *
 * Only these fields are read, so the rest of `WorkerDeps` is a placeholder; a full
 * object would need a live plugin context.
 */
function makeWorkerDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    defaultModel: { providerID: "compass", id: "deepseek-v4.1-flash", variant: "default" },
    knownModels: new Set(["compass/deepseek-v4.1-flash", "compass/other-model"]),
    modelVariants: null,
    ...overrides,
  } as unknown as WorkerDeps
}

describe("resolveMode", () => {
  it("defaults to agentic", () => {
    expect(resolveMode(undefined, "w")).toBe("agentic")
  })

  it("accepts both documented modes", () => {
    expect(resolveMode("agentic", "w")).toBe("agentic")
    expect(resolveMode("oneshot", "w")).toBe("oneshot")
  })

  it("rejects anything else instead of quietly falling back to agentic", () => {
    // A silent fallback would run a full agentic worker where the script asked for
    // a cheap one - the exact opposite of what the mode means.
    expect(() => resolveMode("single", "w")).toThrow(OdwError)
    expect(() => resolveMode("ONE SHOT", "w")).toThrow(/unknown mode/)
    expect(() => resolveMode("", "w")).toThrow(/unknown mode/)
  })
})

describe("resolveWorkerModel", () => {
  it("inherits the session model when neither model nor effort is given", () => {
    const deps = makeWorkerDeps()
    const result = resolveWorkerModel(deps, { prompt: "x" }, "w")
    expect(result.source).toBe("inherited")
    expect(result.ref).toEqual({ providerID: "compass", id: "deepseek-v4.1-flash", variant: "default" })
  })

  it("reports no model at all when the session has none", () => {
    const deps = makeWorkerDeps({ defaultModel: null })
    expect(resolveWorkerModel(deps, { prompt: "x" }, "w").ref).toBeNull()
  })

  it("parses an explicit model, including its #variant", () => {
    const deps = makeWorkerDeps()
    const result = resolveWorkerModel(deps, { prompt: "x", model: "compass/other-model#high" }, "w")
    expect(result.source).toBe("model")
    expect(result.ref).toEqual({ providerID: "compass", id: "other-model", variant: "high" })
  })

  it("turns `effort` into the inherited model's variant", () => {
    const deps = makeWorkerDeps()
    const result = resolveWorkerModel(deps, { prompt: "x", effort: "high" }, "w")
    expect(result.source).toBe("effort")
    expect(result.ref).toEqual({ providerID: "compass", id: "deepseek-v4.1-flash", variant: "high" })
  })

  it("refuses `model` and `effort` together rather than picking a winner", () => {
    const deps = makeWorkerDeps()
    expect(() => resolveWorkerModel(deps, { prompt: "x", model: "compass/other-model", effort: "high" }, "w")).toThrow(
      /both model and effort/,
    )
  })

  it("refuses `effort` when there is no inherited model to apply it to", () => {
    const deps = makeWorkerDeps({ defaultModel: null })
    expect(() => resolveWorkerModel(deps, { prompt: "x", effort: "high" }, "w")).toThrow(/no default model to inherit/)
  })

  it("rejects an unknown model, naming the worker", () => {
    const deps = makeWorkerDeps()
    expect(() => resolveWorkerModel(deps, { prompt: "x", model: "nope/nope" }, "w")).toThrow(/unknown model/)
    try {
      resolveWorkerModel(deps, { prompt: "x", model: "nope/nope" }, "labelled")
    } catch (error) {
      expect((error as Error).message).toContain("labelled")
    }
  })

  it("validates a variant when the host reported that model's variants", () => {
    const deps = makeWorkerDeps({
      modelVariants: new Map([["compass/other-model", new Set(["low", "high"])]]),
    })
    expect(resolveWorkerModel(deps, { prompt: "x", model: "compass/other-model#high" }, "w").ref?.variant).toBe("high")
    expect(() => resolveWorkerModel(deps, { prompt: "x", model: "compass/other-model#max" }, "w")).toThrow(
      /unknown variant "max"/,
    )
    expect(() => resolveWorkerModel(deps, { prompt: "x", effort: "max" }, "w")).not.toThrow()
  })

  it("treats a missing or empty variant list as unknown, not as a rejection", () => {
    const empty = makeWorkerDeps({ modelVariants: new Map([["compass/other-model", new Set()]]) })
    expect(resolveWorkerModel(empty, { prompt: "x", model: "compass/other-model#whatever" }, "w").ref?.variant).toBe(
      "whatever",
    )
    const none = makeWorkerDeps({ modelVariants: null })
    expect(resolveWorkerModel(none, { prompt: "x", model: "compass/other-model#whatever" }, "w").ref?.variant).toBe(
      "whatever",
    )
  })

  it("skips the model check entirely when the inventory is unknown", () => {
    const deps = makeWorkerDeps({ knownModels: null })
    expect(resolveWorkerModel(deps, { prompt: "x", model: "who/knows" }, "w").ref?.id).toBe("knows")
  })

  it("treats an empty model string as a bad argument, not as 'inherit'", () => {
    const deps = makeWorkerDeps()
    expect(() => resolveWorkerModel(deps, { prompt: "x", model: "   " }, "w")).toThrow(OdwError)
  })
})

describe("oneshot posture", () => {
  it("denies everything, including the read tools a read-only worker keeps", () => {
    const readOnly = new Set(resolvePermissions("read-only")?.map((rule) => rule.action))
    expect(readOnly.has("edit")).toBe(true)
    expect(readOnly.has("read")).toBe(false)
    expect(DENY_ALL_RULES).toHaveLength(1)
    expect(DENY_ALL_RULES[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(READ_ONLY_RULES.length).toBeGreaterThan(1)
  })

  it("reports the implicit deny-all posture honestly instead of as 'inherit'", () => {
    expect(describePermissions(undefined)).toBe("inherit")
    expect(describePermissions(undefined, "agentic")).toBe("inherit")
    expect(describePermissions(undefined, "oneshot")).toBe("deny-all")
    // An explicit spec always wins, in both modes.
    expect(describePermissions("read-only", "oneshot")).toBe("read-only")
    expect(describePermissions([{ action: "read", resource: "*", effect: "allow" }], "oneshot")).toBe("custom")
  })

  it("tells the model there are no tools, so a file request is not attempted twice", () => {
    const prompt = buildOneshotPrompt("Summarise this text.", undefined)
    expect(prompt).toContain("no tools available")
    expect(prompt).toContain("Summarise this text.")
  })

  it("still carries the JSON-schema instruction when one is requested", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
    const prompt = buildOneshotPrompt("Decide.", schema)
    expect(prompt).toContain("single JSON value")
    expect(prompt).toContain('"ok"')
    // The agentic prompt has no such preamble.
    expect(buildWorkerPrompt("Decide.", schema)).not.toContain("no tools available")
  })
})
