import type { RunContext, ScriptResult } from "../types.ts"

import { VmScriptHost } from "./host-vm.ts"

export type ScriptRunOptions = {
  /** Wall-clock budget, enforced by the host race (the sandbox itself cannot see time). */
  timeoutMs: number
  /**
   * Budget for the script's *synchronous* prefix (module evaluation + everything
   * before its first `await`). Enforced by `vm`'s own watchdog, which is the only
   * thing that can interrupt a busy loop.
   */
  syncTimeoutMs: number
  signal: AbortSignal
  /** Virtual filename used in stack traces, e.g. `run-123/workflow.ts`. */
  filename: string
}

/**
 * The capability fence. A implementation is chosen from the measured contract
 * facts (PLAN §1 C11): `node:vm` with `codeGeneration` disabled is the A tier and
 * is what M2 ships. `worker_threads` (B tier) stays unimplemented until something
 * actually needs it - see PLAN §14.
 */
export interface ScriptHost {
  readonly tier: "A" | "B"
  readonly implementation: string
  run(source: string, ctx: RunContext, options: ScriptRunOptions): Promise<ScriptResult>
}

/**
 * Returns the ScriptHost for this process.
 *
 * There is exactly one implementation today (A tier, `node:vm`). The indirection
 * exists so the escalation path in PLAN §14 - swap in a `worker_threads` host if
 * the capability gate ever proves insufficient - is a one-line change here rather
 * than a refactor of the runner. `host-vm.ts` imports this module type-only, so
 * this runtime import introduces no cycle.
 */
export function createScriptHost(): ScriptHost {
  return new VmScriptHost()
}
