import type { Budget } from "../runner/budget.ts"
import type { Deadline } from "../runner/deadline.ts"
import type { RunContext } from "../types.ts"
import type { WorkerDeps } from "../worker/agentic.ts"

import { createAgentPrimitive } from "./agent.ts"
import { createParallelPrimitive } from "./parallel.ts"

export type PrimitiveDeps = {
  readonly worker: WorkerDeps
  readonly deadline: Deadline
  readonly budget: Budget
  /** Run-level concurrency ceiling; `parallel` clamps its own option to this. */
  readonly concurrency: number
  readonly log: (message: string) => void
  readonly phase: (name: string) => void
}

/**
 * Builds the `ctx` handed into the sandbox.
 *
 * This object is the whole trusted surface: every property on it is a host
 * function that the sandbox can only *call*, never reach through. Anything added
 * here has to be safe against a hostile script, because the sandbox cannot
 * otherwise be trusted to keep itself in bounds.
 */
export function createRunContext(deps: PrimitiveDeps): RunContext {
  const agent = createAgentPrimitive(deps)
  const parallel = createParallelPrimitive(deps)

  return {
    agent,
    parallel,
    log: (...args: unknown[]) => {
      deps.log(args.map(formatLogArg).join(" "))
    },
    phase: (name: string) => {
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("ctx.phase(name) 的 name 必须是非空字符串")
      }
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
