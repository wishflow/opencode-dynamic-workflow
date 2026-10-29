import vm from "node:vm"

import { WorkflowAbortedError, toScriptError, type RunContext, type ScriptResult, type ScriptError } from "../types.ts"
import type { ScriptHost, ScriptRunOptions } from "./host.ts"
import { asCallableExpression, normalizeScript } from "./normalize.ts"

/**
 * A-tier ScriptHost: `node:vm`.
 *
 * Verified against opencode 2.1.0 (embedded Bun 1.4.2) in the contract suite:
 *
 *  - `vm.createContext` + `Script.runInContext` work;
 *  - `codeGeneration: { strings: false }` really blocks `eval` / `Function`;
 *  - `runInContext({ timeout })` interrupts `while (true)`, *including* the
 *    synchronous prefix of an async function body;
 *  - the sandbox gets its own realm's built-ins, so `JSON`/`Math`/`Date` are NOT
 *    injected from the host (mixing realms only breaks `instanceof`);
 *  - the sandbox has no ambient `require`, `process`, `Buffer` or `fetch`;
 *  - a host function handed in as a primitive is awaitable from inside.
 *
 * What `vm` cannot do is interrupt a script that is parked on an `await`: its
 * watchdog only covers synchronous execution. That is why every primitive calls
 * `Deadline.check()`, and why the runner races the whole script against a timer.
 */
export class VmScriptHost implements ScriptHost {
  readonly tier = "A" as const
  readonly implementation = "node:vm"

  async run(source: string, ctx: RunContext, options: ScriptRunOptions): Promise<ScriptResult> {
    const started = Date.now()
    if (options.signal.aborted) {
      return this.aborted(started)
    }

    let normalized: string
    try {
      normalized = normalizeScript(source)
    } catch (error) {
      return { status: "error", error: toScriptError(error), elapsedMs: Date.now() - started }
    }

    // Only these two names exist inside the sandbox. Everything else is the
    // sandbox realm's own globals plus ECMAScript.
    const sandbox: Record<string, unknown> = {
      __odw_ctx: ctx,
      console: createSandboxConsole(ctx),
    }

    const context = vm.createContext(sandbox, {
      name: "odw-workflow",
      codeGeneration: { strings: false, wasm: false },
    })

    let pending: unknown
    try {
      const script = new vm.Script(`${asCallableExpression(normalized)}(__odw_ctx)`, {
        filename: options.filename,
      })
      pending = script.runInContext(context, {
        timeout: Math.max(1, Math.min(options.syncTimeoutMs, options.timeoutMs)),
        displayErrors: true,
      })
    } catch (error) {
      return { status: "error", error: classify(error), elapsedMs: Date.now() - started }
    }

    // Cross-realm: the value is a vm-realm promise, so `instanceof Promise` is
    // false here (measured). Awaiting it works regardless of realm.
    try {
      const returnValue = await (pending as Promise<unknown>)
      return { status: "ok", returnValue, elapsedMs: Date.now() - started }
    } catch (error) {
      return { status: "error", error: classify(error), elapsedMs: Date.now() - started }
    }
  }

  private aborted(started: number): ScriptResult {
    return {
      status: "error",
      error: { kind: "aborted", message: "workflow was cancelled" },
      elapsedMs: Date.now() - started,
    }
  }
}

function classify(error: unknown): ScriptError {
  if (error instanceof WorkflowAbortedError) {
    return { kind: "aborted", message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/Script execution timed out/i.test(message)) {
    return { kind: "timeout", message: `the script's synchronous section exceeded its time budget: ${message}` }
  }
  return toScriptError(error)
}

function createSandboxConsole(ctx: RunContext): Record<string, (...args: unknown[]) => void> {
  const forward =
    (level: string) =>
    (...args: unknown[]): void => {
      ctx.log(`[${level}]`, ...args)
    }
  return {
    log: forward("log"),
    info: forward("info"),
    debug: forward("debug"),
    warn: forward("warn"),
    error: forward("error"),
  }
}
