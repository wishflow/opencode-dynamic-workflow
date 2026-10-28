import { Plugin } from "@opencode/plugin"

import { registerCommands } from "./plugin/commands.ts"
import { withSetupGuard } from "./plugin/guard.ts"
import { registerTools } from "./plugin/tools.ts"
import { readTriggerOption, registerPromptHook } from "./plugin/trigger.ts"

/**
 * opencode-dynamic-workflow.
 *
 * Hard constraint (measured, PLAN §1 C10 / §3.7): plugin `setup` runs once per
 * *discovered plugin location*, it must be cheap and repeatable, and a model call
 * made from it deadlocks the host server. `setup` therefore only registers
 * tools/commands/hooks; every worker is created from inside `odw_run`, which runs
 * in a normal tool context.
 *
 * The three registrations are independent by design: losing the prompt hook costs
 * only the hint, losing the command costs only the `/workflow` entry point, and
 * neither affects `odw_run`.
 */
export default Plugin.define({
  id: "odw",
  async setup(ctx) {
    return withSetupGuard(async () => {
      const cleanups = [
        await registerTools(ctx),
        await registerCommands(ctx),
        await registerPromptHook(ctx, { trigger: readTriggerOption(ctx.options) }),
      ]

      return async () => {
        for (const cleanup of cleanups) await cleanup()
      }
    })
  },
})
