import { Plugin } from "@opencode/plugin"

import { registerCommands } from "./plugin/commands.ts"
import { withSetupGuard } from "./plugin/guard.ts"
import { registerTools } from "./plugin/tools.ts"

/**
 * opencode-dynamic-workflow.
 *
 * Hard constraint (measured): plugin `setup` runs once per *discovered plugin
 * location*, it must be cheap and repeatable, and a model call made from it
 * deadlocks the host server. `setup` therefore only registers tools and commands;
 * every worker is created from inside `odw_run`, which runs in a normal tool
 * context.
 *
 * Natural-language triggering is deliberately *not* this plugin's job. The `odw`
 * skill carries both when-to (its description) and how-to (its body); the plugin
 * injects nothing into the user's prompt. The two registrations here are
 * independent by design: losing the command costs only the `/workflow` entry point,
 * and neither affects `odw_run`.
 */
export default Plugin.define({
  id: "odw",
  async setup(ctx) {
    return withSetupGuard(async () => {
      const cleanups = [await registerTools(ctx), await registerCommands(ctx)]

      return async () => {
        for (const cleanup of cleanups) await cleanup()
      }
    })
  },
})
