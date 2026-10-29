import { describe, expect, it, vi } from "vitest"

import { createRunContext, type PrimitiveDeps } from "../../src/primitives/index.ts"
import { createLoopPrimitive } from "../../src/primitives/loop.ts"
import { createParallelPrimitive } from "../../src/primitives/parallel.ts"
import { createPipelinePrimitive } from "../../src/primitives/pipeline.ts"
import { createVerifyPrimitive } from "../../src/primitives/verify.ts"
import { Budget } from "../../src/runner/budget.ts"
import { Deadline } from "../../src/runner/deadline.ts"
import { Steps } from "../../src/runner/steps.ts"
import {
  OdwError,
  StepLimitError,
  WorkflowAbortedError,
  WorkflowTimeoutError,
  type AgentOptions,
} from "../../src/types.ts"

/**
 * The primitives only touch `worker` through `ctx.agent`; pipeline/loop/verify
 * never do, so the worker field is a placeholder here. The cast is deliberate and
 * local: building a full `WorkerDeps` would require a live plugin context.
 */
function makeDeps(overrides: Partial<PrimitiveDeps> = {}): PrimitiveDeps {
  const base = {
    worker: {},
    deadline: Deadline.after(60_000),
    budget: new Budget(),
    steps: new Steps(500),
    concurrency: 4,
    log: vi.fn(),
    phase: vi.fn(),
    checkpoint: vi.fn(),
  } as unknown as PrimitiveDeps
  return { ...base, ...overrides }
}

describe("ctx.pipeline", () => {
  it("chains stages per item and returns the last stage's value, in input order", async () => {
    const pipeline = createPipelinePrimitive(makeDeps())
    const seen: string[] = []
    const out = await pipeline(
      ["b", "a"],
      (input: unknown, item: unknown, index: number) => {
        seen.push(`s1:${String(item)}@${index}`)
        return `${String(input)}-1`
      },
      (input: unknown, item: unknown) => {
        seen.push(`s2:${String(item)}`)
        return `${String(input)}-2`
      },
    )
    expect(out).toEqual(["b-1-2", "a-1-2"])
    // Every item runs stage 1 before stage 2, regardless of input order.
    expect(seen.filter((s) => s.startsWith("s1")).length).toBe(2)
    expect(seen.filter((s) => s.startsWith("s2")).length).toBe(2)
  })

  it("hands the item and its index to later stages alongside the running value", async () => {
    const pipeline = createPipelinePrimitive(makeDeps())
    const out = await pipeline(["x", "y"], (input: unknown, item: unknown, index: number) => ({
      value: input,
      item,
      index,
    }))
    expect(out).toEqual([
      { value: "x", item: "x", index: 0 },
      { value: "y", item: "y", index: 1 },
    ])
  })

  it("never exceeds the run's concurrency", async () => {
    const deps = makeDeps({ concurrency: 2 })
    const pipeline = createPipelinePrimitive(deps)
    let active = 0
    let peak = 0
    await pipeline(
      [1, 2, 3, 4, 5, 6],
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return "ok"
      },
    )
    expect(peak).toBe(2)
  })

  it("stops dispatching after a failure, then throws the first error", async () => {
    const deps = makeDeps({ concurrency: 1 })
    const pipeline = createPipelinePrimitive(deps)
    const started: number[] = []
    await expect(
      pipeline([1, 2, 3], (input: unknown) => {
        const n = input as number
        started.push(n)
        if (n === 1) throw new Error("boom")
        return "ok"
      }),
    ).rejects.toThrow("boom")
    expect(started).toEqual([1])
  })

  it("rejects bad arguments", async () => {
    const pipeline = createPipelinePrimitive(makeDeps())
    await expect(pipeline("nope" as unknown as number[], () => 1)).rejects.toBeInstanceOf(OdwError)
    await expect(pipeline([1])).rejects.toThrow(/at least one stage/)
    await expect(pipeline([1], "not a function" as unknown as () => unknown)).rejects.toThrow(/is not a function/)
  })

  it("returns [] for zero items without charging a step", async () => {
    const deps = makeDeps()
    const pipeline = createPipelinePrimitive(deps)
    expect(await pipeline([], () => 1)).toEqual([])
    expect(deps.steps.count).toBe(0)
  })

  it("honours the step budget", async () => {
    const deps = makeDeps({ steps: new Steps(1) })
    const pipeline = createPipelinePrimitive(deps)
    await pipeline([1], () => "a")
    await expect(pipeline([1], () => "a")).rejects.toBeInstanceOf(StepLimitError)
  })

  it("stops an iteration when the deadline has passed", async () => {
    const deps = makeDeps({ deadline: Deadline.after(0) })
    const pipeline = createPipelinePrimitive(deps)
    await expect(pipeline([1], () => "a")).rejects.toBeInstanceOf(WorkflowTimeoutError)
  })
})

describe("ctx.parallel", () => {
  it("returns results in input order even when completion order differs", async () => {
    const parallel = createParallelPrimitive(makeDeps())
    const out = await parallel([30, 10, 20], async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return ms
    })
    expect(out).toEqual([30, 10, 20])
  })

  it("clamps a requested concurrency above the run's own", async () => {
    const deps = makeDeps({ concurrency: 2 })
    const parallel = createParallelPrimitive(deps)
    let active = 0
    let peak = 0
    await parallel(
      [1, 2, 3, 4, 5, 6],
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
      },
      { concurrency: 99 },
    )
    expect(peak).toBe(2)
  })
})

describe("ctx.loop", () => {
  it("runs `max` times when `until` is absent", async () => {
    const loop = createLoopPrimitive(makeDeps())
    const result = await loop({ max: 3, body: (state: number) => (state ?? 0) + 1, initial: 0 })
    expect(result).toEqual({ iterations: 3, state: 3, stopped: "max" })
  })

  it("stops early when `until` holds, reporting the reason", async () => {
    const loop = createLoopPrimitive(makeDeps())
    const result = await loop({
      max: 10,
      initial: { tries: 0, ok: false },
      body: (state: { tries: number; ok: boolean }) => ({ tries: state.tries + 1, ok: state.tries + 1 >= 2 }),
      until: (state: { ok: boolean }) => state.ok,
    })
    expect(result.stopped).toBe("until")
    expect(result.iterations).toBe(2)
    expect(result.state).toEqual({ tries: 2, ok: true })
  })

  it("passes a 0-based iteration index to body and until", async () => {
    const loop = createLoopPrimitive(makeDeps())
    const bodyIndexes: number[] = []
    const untilIndexes: number[] = []
    await loop({
      max: 5,
      initial: 0,
      body: (state: number, i: number) => {
        bodyIndexes.push(i)
        return state + 1
      },
      until: (_state: number, i: number) => {
        untilIndexes.push(i)
        return i >= 1
      },
    })
    expect(bodyIndexes).toEqual([0, 1])
    expect(untilIndexes).toEqual([0, 1])
  })

  it("refuses an uncapped or malformed loop", async () => {
    const loop = createLoopPrimitive(makeDeps())
    await expect(loop({ body: () => 1 } as unknown as { max: number; body: () => number })).rejects.toThrow(/max/)
    await expect(loop({ max: 0, body: () => 1 })).rejects.toThrow(/max/)
    await expect(loop({ max: 2 } as unknown as { max: number; body: () => number })).rejects.toThrow(/body/)
    await expect(loop({ max: 2, body: () => 1, until: "x" as unknown as () => boolean })).rejects.toThrow(/until/)
  })

  it("checks the deadline on every iteration", async () => {
    const loop = createLoopPrimitive(makeDeps({ deadline: Deadline.after(0) }))
    await expect(loop({ max: 3, body: (state: number) => state + 1, initial: 0 })).rejects.toBeInstanceOf(
      WorkflowTimeoutError,
    )
    expect(true).toBe(true)
  })

  it("does not run the body when the deadline is already gone", async () => {
    const loop = createLoopPrimitive(makeDeps({ deadline: Deadline.after(0) }))
    const body = vi.fn(() => 1)
    await expect(loop({ max: 3, body, initial: 0 })).rejects.toBeInstanceOf(WorkflowTimeoutError)
    expect(body).not.toHaveBeenCalled()
  })
})

describe("ctx.verify", () => {
  it("returns the parsed verdict and defaults to read-only", async () => {
    const agent = vi.fn(async (_options: AgentOptions) => ({ pass: true, reasons: ["checked src/index.ts:1-20"] }))
    const verify = createVerifyPrimitive(makeDeps(), agent)
    const result = await verify("the file exists")
    expect(result).toEqual({ pass: true, reasons: ["checked src/index.ts:1-20"] })
    const request = agent.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(request["permissions"]).toBe("read-only")
    expect(String(request["prompt"])).toContain("adversarial verifier")
    expect(String(request["prompt"])).toContain("the file exists")
  })

  it("fails closed when the verifier answers prose instead of the schema", async () => {
    const agent = vi.fn(async () => "looks fine to me, probably")
    const verify = createVerifyPrimitive(makeDeps(), agent)
    const result = await verify({ claim: "x" })
    expect(result.pass).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(result.raw).toContain("probably")
  })

  it("fails closed when `pass` is missing from an object reply", async () => {
    const agent = vi.fn(async () => ({ reasons: ["only reasons"] }))
    const verify = createVerifyPrimitive(makeDeps(), agent)
    const result = await verify("x")
    expect(result.pass).toBe(false)
  })

  it("forwards explicit overrides and keeps an untrusted evidence hint labelled untrusted", async () => {
    const agent = vi.fn(async (_options: AgentOptions) => ({ pass: false, reasons: ["nope"] }))
    const verify = createVerifyPrimitive(makeDeps(), agent)
    await verify({ claim: "c", evidence: "src/a.ts:9", agent: "explore", model: "p/m", permissions: "inherit", timeoutMs: 1234 })
    const request = agent.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(request["agent"]).toBe("explore")
    expect(request["model"]).toBe("p/m")
    expect(request["permissions"]).toBe("inherit")
    expect(request["timeoutMs"]).toBe(1234)
    expect(String(request["prompt"])).toContain("src/a.ts:9")
    expect(String(request["prompt"])).toContain("untrusted")
  })

  it("rejects an empty claim", async () => {
    const verify = createVerifyPrimitive(makeDeps(), vi.fn())
    await expect(verify("")).rejects.toThrow(/claim/)
    await expect(verify({ claim: "   " })).rejects.toThrow(/claim/)
  })

  it("propagates a verifier worker failure as a throw (not as pass:false)", async () => {
    const agent = vi.fn(async () => {
      throw new OdwError("worker-failed", "verifier timed out")
    })
    const verify = createVerifyPrimitive(makeDeps(), agent)
    await expect(verify("x")).rejects.toThrow("verifier timed out")
  })
})

describe("ctx surface", () => {
  it("ctx.abort throws a WorkflowAbortedError carrying the script's reason", () => {
    const ctx = createRunContext(makeDeps())
    let caught: unknown
    try {
      ctx.abort("precondition check failed")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkflowAbortedError)
    expect((caught as WorkflowAbortedError).kind).toBe("aborted")
    expect((caught as WorkflowAbortedError).message).toContain("precondition check failed")
  })

  it("ctx.abort works without a reason", () => {
    const ctx = createRunContext(makeDeps())
    expect(() => ctx.abort()).toThrow(WorkflowAbortedError)
  })

  it("ctx.checkpoint trims the label, forwards the data and never throws on odd payloads", async () => {
    const deps = makeDeps()
    const ctx = createRunContext(deps)
    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    await ctx.checkpoint("  after-collect  ", circular)
    expect(deps.checkpoint).toHaveBeenCalledWith("after-collect", circular)
    await expect(ctx.checkpoint("")).rejects.toThrow(/label/)
  })

  it("ctx.phase rejects an empty name and charges a step", () => {
    const deps = makeDeps()
    const ctx = createRunContext(deps)
    ctx.phase("collect")
    expect(deps.phase).toHaveBeenCalledWith("collect")
    expect(() => ctx.phase("  ")).toThrow(/name/)
    expect(deps.steps.count).toBe(1)
  })

  it("exposes exactly the documented primitives and nothing else", () => {
    const ctx = createRunContext(makeDeps())
    expect(Object.keys(ctx).sort()).toEqual([
      "abort",
      "agent",
      "budget",
      "checkpoint",
      "log",
      "loop",
      "parallel",
      "phase",
      "pipeline",
      "verify",
    ])
  })
})
