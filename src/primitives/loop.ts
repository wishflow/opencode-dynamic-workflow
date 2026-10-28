import type { PrimitiveDeps } from "./index.ts"

import { OdwError, type LoopOptions, type LoopState } from "../types.ts"

/**
 * `ctx.loop` - retry/iterate until a condition holds, with a hard cap.
 *
 * The shape it exists for: "try to fix the failing test; after each attempt ask
 * whether it passes now; give up after 3 attempts". Writing that as a raw `while`
 * in the script is possible but unbounded - the script author is a model, and a
 * loop with a wrong exit condition is the single cheapest way to burn an account.
 * `max` is therefore mandatory and `until` is checked *after* each body run, so
 * the cap is a real cap and not one iteration more.
 *
 * The return value keeps what a `while` loop throws away: how many iterations
 * actually ran, why it stopped, and the final state. A script that must report
 * "passed on attempt 2 of 3" needs all three.
 */
export function createLoopPrimitive(deps: PrimitiveDeps) {
  return async function loop<S = unknown>(options: LoopOptions<S>): Promise<LoopState<S>> {
    if (options === null || typeof options !== "object") {
      throw new OdwError("bad-args", "ctx.loop({ max, body, until? }) 需要一个对象参数")
    }
    const requested = options.max
    if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1) {
      throw new OdwError(
        "bad-args",
        `ctx.loop 的 max 必须是 >= 1 的整数（收到 ${JSON.stringify(requested)}）：没有上限的循环不允许`,
      )
    }
    if (typeof options.body !== "function") {
      throw new OdwError("bad-args", "ctx.loop 的 body 必须是函数 (state, i) => newState")
    }
    if (options.until !== undefined && typeof options.until !== "function") {
      throw new OdwError("bad-args", "ctx.loop 的 until 必须是函数 (state, i) => boolean")
    }

    const limit = Math.floor(requested)
    const until = options.until
    deps.steps.claim("ctx.loop")
    let state = options.initial as S
    let iterations = 0

    while (iterations < limit) {
      // Checked per iteration, not only per `loop` call: a body that awaits a
      // worker each turn is exactly the case the wall clock is there to stop.
      deps.deadline.check(`loop 第 ${iterations + 1} 次迭代（上限 ${limit}）`)
      state = await options.body(state, iterations)
      iterations += 1
      if (until !== undefined && until(state, iterations - 1)) {
        deps.log(`loop: 第 ${iterations} 次迭代后 until 成立，提前结束（上限 ${limit}）`)
        return { iterations, state, stopped: "until" }
      }
    }

    deps.log(`loop: 用满上限 ${limit} 次迭代，until 未成立`)
    return { iterations, state, stopped: "max" }
  }
}
