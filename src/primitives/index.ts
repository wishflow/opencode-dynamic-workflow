import type { Budget } from "../runner/budget.ts"
import type { Deadline } from "../runner/deadline.ts"
import type { Steps } from "../runner/steps.ts"
import { WorkflowAbortedError, type RunContext } from "../types.ts"
import type { WorkerDeps } from "../worker/agentic.ts"

import { createAgentPrimitive } from "./agent.ts"
import { createLoopPrimitive } from "./loop.ts"
import { createParallelPrimitive } from "./parallel.ts"
import { createPipelinePrimitive } from "./pipeline.ts"
import { createVerifyPrimitive } from "./verify.ts"

export type PrimitiveDeps = {
  readonly worker: WorkerDeps
  readonly deadline: Deadline
  readonly budget: Budget
  readonly steps: Steps
  /** Run-level concurrency ceiling; `parallel`/`pipeline` clamp their own option to this. */
  readonly concurrency: number
  readonly log: (message: string) => void
  readonly phase: (name: string) => void
  /** Persists a named marker; the runner owns the artifact layout. */
  readonly checkpoint: (label: string, data: unknown) => void
}

/**
 * Builds the `ctx` handed into the sandbox.
 *
 * This object is the whole trusted surface: every property on it is a host
 * function that the sandbox can only *call*, never reach through. Anything added
 * here has to be safe against a hostile script, because the sandbox cannot
 * otherwise be trusted to keep itself in bounds.
 *
 * Every entry is therefore a thin wrapper that (1) type/length-checks its
 * arguments - the sandbox is a separate realm, so nothing it passes is trusted -
 * and (2) spends one step from the step budget before doing work.
 */
export function createRunContext(deps: PrimitiveDeps): RunContext {
  const agent = createAgentPrimitive(deps)
  const parallel = createParallelPrimitive(deps)
  const pipeline = createPipelinePrimitive(deps)
  const loop = createLoopPrimitive(deps)
  const verify = createVerifyPrimitive(deps, agent)

  return {
    agent,
    parallel,
    pipeline,
    loop,
    verify,
    checkpoint: async (label: string, data?: unknown) => {
      if (typeof label !== "string" || label.trim() === "") {
        throw new Error("ctx.checkpoint(label, data?) needs label to be a non-empty string")
      }
      deps.steps.claim("ctx.checkpoint")
      deps.checkpoint(label.trim(), data)
    },
    abort: (reason?: string) => {
      // Thrown, not signalled: the run ends exactly here, with the script's own
      // words in the error, and it is the runner that turns this into a failed
      // run. Returning instead would let a caller keep dispatching workers after
      // asking to stop.
      throw new WorkflowAbortedError(
        typeof reason === "string" && reason.trim() !== "" ? `script aborted deliberately: ${reason.trim()}` : "script aborted deliberately",
      )
    },
    log: (...args: unknown[]) => {
      // Counted like any other primitive: a runaway `while` that only logs is
      // cheap in workers but unbounded in journal size, and this is the guard
      // that catches exactly that shape.
      deps.steps.claim("ctx.log")
      deps.log(args.map(formatLogArg).join(" "))
    },
    phase: (name: string) => {
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("ctx.phase(name) needs name to be a non-empty string")
      }
      deps.steps.claim("ctx.phase")
      deps.phase(name.trim())
    },
    budget: () => deps.budget.snapshot(),
  }
}

function formatLogArg(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
