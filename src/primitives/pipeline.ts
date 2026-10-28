import type { PrimitiveDeps } from "./index.ts"

import { Semaphore } from "../runner/semaphore.ts"
import { OdwError, type PipelineStage } from "../types.ts"

/**
 * `ctx.pipeline` - fan out over items, then run the same chain of stages on each.
 *
 * The shape it exists for: "for every file, (1) summarise it, then (2) review the
 * summary". `parallel` cannot express that without nesting a call per item, which
 * loses the run-level concurrency bound; here the bound applies to *items in
 * flight*, and the stages inside one item run in order.
 *
 * Same two load-bearing properties as `parallel` (see `parallel.ts`): a private
 * limiter rather than the worker semaphore (nesting would deadlock), and
 * stop-dispatch-then-wait rather than `Promise.all`. Results come back in input
 * order, holding the **last** stage's value.
 */
export function createPipelinePrimitive(deps: PrimitiveDeps) {
  return async function pipeline<T, R = unknown>(
    items: readonly T[],
    ...stages: readonly PipelineStage[]
  ): Promise<R[]> {
    if (!Array.isArray(items)) {
      throw new OdwError("bad-args", "ctx.pipeline(items, ...stages) 的 items 必须是数组")
    }
    if (stages.length === 0) {
      throw new OdwError("bad-args", "ctx.pipeline(items, ...stages) 至少需要一个 stage 函数")
    }
    for (const [index, stage] of stages.entries()) {
      if (typeof stage !== "function") {
        throw new OdwError("bad-args", `ctx.pipeline 的第 ${index + 1} 个 stage 不是函数（收到 ${typeof stage}）`)
      }
    }
    if (items.length === 0) return []

    const limit = Math.max(1, Math.floor(deps.concurrency))
    deps.steps.claim("ctx.pipeline")
    const results = new Array<R>(items.length)
    const failures: unknown[] = []
    let stopped = false
    const limiter = new Semaphore(limit)

    deps.log(`pipeline: ${items.length} 项 × ${stages.length} 阶段，并发 ${limit}`)

    await Promise.all(
      items.map((item, index) =>
        limiter.run(async () => {
          if (stopped) return
          try {
            let value: unknown = item
            for (const [stageIndex, stage] of stages.entries()) {
              deps.deadline.check(`pipeline[${index}] stage ${stageIndex + 1}`)
              // The item and its index are passed alongside the running value so a
              // later stage can still frame its prompt ("reviewing X, from file Y")
              // without the caller having to thread context through by hand.
              value = await stage(value, item, index)
            }
            results[index] = value as R
          } catch (error) {
            stopped = true
            failures.push(error)
          }
        }),
      ),
    )

    if (failures.length > 0) {
      const first = failures[0]
      if (failures.length === 1) throw first
      const names = failures
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .slice(0, 3)
        .join(" | ")
      throw new OdwError("internal", `pipeline 有 ${failures.length} 项失败（只抛第一个）：${names}`)
    }
    if (stopped) {
      throw new OdwError("internal", "pipeline 被提前终止")
    }
    return results
  }
}
