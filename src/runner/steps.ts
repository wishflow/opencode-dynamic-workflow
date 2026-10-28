import { StepLimitError } from "../types.ts"

export const DEFAULT_MAX_STEPS = 500

/**
 * Primitive-call budget.
 *
 * The wall clock and the worker cap both bound *spend*, but neither bounds a
 * script that spins cheaply: `while (true) { await ctx.log("x") }` burns no
 * workers and no model turns, yet grows the journal without limit and keeps a
 * session alive. Counting primitive calls catches exactly that shape, and it
 * costs one integer per call.
 *
 * Only *primitive* calls are counted, not JavaScript statements - the vm's own
 * watchdog already covers a purely synchronous spin.
 */
export class Steps {
  private used = 0

  constructor(private readonly max: number = DEFAULT_MAX_STEPS) {}

  get count(): number {
    return this.used
  }

  get limit(): number {
    return this.max
  }

  claim(what: string): void {
    this.used += 1
    if (this.used > this.max) {
      throw new StepLimitError(
        `原语调用步数超过上限 ${this.max}（在第 ${this.used} 步「${what}」）：脚本疑似失控，已中止。` +
          `把批量工作交给 ctx.parallel / ctx.pipeline，而不是在脚本里写长循环。`,
      )
    }
  }
}
