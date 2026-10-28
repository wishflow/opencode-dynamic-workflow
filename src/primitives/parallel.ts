import type { PrimitiveDeps } from "./index.ts"

import { Semaphore } from "../runner/semaphore.ts"
import { OdwError, type ParallelOptions } from "../types.ts"

/**
 * `ctx.parallel` - fan out over items with bounded concurrency.
 *
 * Two properties are load-bearing:
 *
 * 1. **It does not use the worker semaphore.** Its callback normally calls
 *    `ctx.agent`, which acquires that semaphore. Reusing it here would nest two
 *    acquisitions of the same resource and deadlock the run the moment
 *    `concurrency` was reached. The limiter below only bounds *items in flight*.
 * 2. **A rejection stops dispatch, then waits.** `Promise.all` would reject
 *    immediately and leave the still-queued items running unsupervised, after the
 *    run had already returned its error; `allSettled` plus a stop flag lets the
 *    in-flight workers finish (so their transcripts and spend are recorded) while
 *    guaranteeing no *new* item starts.
 *
 * Results come back in input order, never completion order.
 */
export function createParallelPrimitive(deps: PrimitiveDeps) {
  return async function parallel<T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R> | R,
    options?: ParallelOptions,
  ): Promise<R[]> {
    if (!Array.isArray(items)) {
      throw new OdwError("bad-args", "ctx.parallel(items, fn) 的 items 必须是数组")
    }
    if (typeof fn !== "function") {
      throw new OdwError("bad-args", "ctx.parallel(items, fn) 的 fn 必须是函数")
    }
    if (items.length === 0) return []

    const requested = options?.concurrency ?? deps.concurrency
    const limit = Math.max(1, Math.min(Math.floor(requested), deps.concurrency))
    const results = new Array<R>(items.length)
    const failures: unknown[] = []
    let stopped = false
    const limiter = new Semaphore(limit)

    deps.log(`parallel: ${items.length} 项，并发 ${limit}`)

    await Promise.all(
      items.map((item, index) =>
        limiter.run(async () => {
          if (stopped) return
          try {
            deps.deadline.check(`parallel[${index}]`)
            results[index] = await fn(item, index)
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
      throw new OdwError("internal", `parallel 有 ${failures.length} 项失败（只抛第一个）：${names}`)
    }
    if (stopped) {
      throw new OdwError("internal", "parallel 被提前终止")
    }
    return results
  }
}
