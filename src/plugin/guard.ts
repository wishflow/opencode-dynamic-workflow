import { SetupModelCallError } from "../types.ts"

/**
 * Measured (PLAN §1 C10 / §3.7): a plugin `setup` runs once per *discovered
 * plugin location* - 18 times in one measured startup - and a model call made
 * from inside it deadlocks the host server. `setup` is therefore only allowed to
 * register tools/commands/hooks.
 *
 * The guard is module-level state rather than a parameter because `setup` can
 * call arbitrary depth of helper code, and a missing guard is a *hang*, not a
 * nice error. Every path that starts a model call goes through `assertNoModelCall`.
 */
let setupDepth = 0

export function enterSetup(): void {
  setupDepth += 1
}

export function exitSetup(): void {
  setupDepth = Math.max(0, setupDepth - 1)
}

export function inSetup(): boolean {
  return setupDepth > 0
}

export function assertNoModelCall(what: string): void {
  if (setupDepth > 0) {
    throw new SetupModelCallError(
      `setup 阶段禁止发起模型调用（${what}）：在 opencode 2.1.0 上会把宿主 server 挂死。` +
        `请把编排放在 tool / command / hook 里（PLAN.md §3.7）。`,
    )
  }
}

/** Runs `fn` with the setup guard armed. Used by the plugin entry point. */
export async function withSetupGuard<T>(fn: () => Promise<T>): Promise<T> {
  enterSetup()
  try {
    return await fn()
  } finally {
    exitSetup()
  }
}
