import type { PrimitiveDeps } from "./index.ts"

import { OdwError, WorkerFailedError, type AgentOptions } from "../types.ts"
import { runAgenticWorker } from "../worker/agentic.ts"

/**
 * `ctx.agent` - one worker, one result.
 *
 * Failures propagate as a thrown `WorkerFailedError`: the script author (the
 * model) decides whether to retry, skip, or abort. There is deliberately no
 * automatic retry here - a silent retry would multiply spend and hide the very
 * failure the run journal exists to show.
 */
export function createAgentPrimitive(deps: PrimitiveDeps) {
  let sequence = 0

  return async function agent<T = string>(options: AgentOptions): Promise<T> {
    if (options === null || typeof options !== "object") {
      throw new OdwError("bad-args", "ctx.agent(options) 需要一个对象参数")
    }
    if (typeof options.prompt !== "string" || options.prompt.trim() === "") {
      throw new OdwError("bad-args", "ctx.agent({ prompt }) 的 prompt 必须是非空字符串")
    }
    if (options.mode === "oneshot") {
      throw new OdwError(
        "not-implemented",
        'ctx.agent({ mode: "oneshot" }) 尚未实现（计划在 M4）；当前请使用默认的 "agentic" 模式',
      )
    }

    sequence += 1
    const outcome = await runAgenticWorker(deps.worker, {
      ...options,
      label: options.label ?? `agent-${sequence}`,
    })
    if (!outcome.ok) {
      throw new WorkerFailedError(outcome)
    }
    return (outcome.json === undefined ? outcome.text : outcome.json) as T
  }
}
