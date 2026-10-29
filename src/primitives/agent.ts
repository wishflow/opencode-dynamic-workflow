import type { PrimitiveDeps } from "./index.ts"

import { OdwError, WorkerFailedError, type AgentOptions } from "../types.ts"
import { runWorker } from "../worker/agentic.ts"

/**
 * `ctx.agent` - one worker, one result.
 *
 * Failures propagate as a thrown `WorkerFailedError`: the script author (the
 * model) decides whether to retry, skip, or abort. There is deliberately no
 * automatic retry here - a silent retry would multiply spend and hide the very
 * failure the run journal exists to show.
 *
 * `mode: "oneshot"` is passed straight through to the worker: the mode changes
 * the worker's posture (tools denied), not the plumbing, so there is one code
 * path for a worker and no second, weaker implementation to drift.
 */
export function createAgentPrimitive(deps: PrimitiveDeps) {
  let sequence = 0

  return async function agent<T = string>(options: AgentOptions): Promise<T> {
    if (options === null || typeof options !== "object") {
      throw new OdwError("bad-args", "ctx.agent(options) needs an object argument")
    }
    if (typeof options.prompt !== "string" || options.prompt.trim() === "") {
      throw new OdwError("bad-args", "ctx.agent({ prompt }) needs prompt to be a non-empty string")
    }

    sequence += 1
    deps.steps.claim("ctx.agent")
    const outcome = await runWorker(deps.worker, {
      ...options,
      label: options.label ?? `agent-${sequence}`,
    })
    if (!outcome.ok) {
      throw new WorkerFailedError(outcome)
    }
    return (outcome.json === undefined ? outcome.text : outcome.json) as T
  }
}
