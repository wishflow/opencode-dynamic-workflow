import { Plugin } from "@opencode/plugin"

import { registerTools } from "./plugin/tools.ts"

/**
 * opencode-dynamic-workflow.
 *
 * Hard constraint (measured, PLAN.md §3.7): a plugin `setup` must never make a
 * model call - it deadlocks the host server. Only tools, commands and hooks may
 * start orchestration.
 */
export default Plugin.define({
  id: "odw",
  async setup(ctx) {
    const cleanups = [await registerTools(ctx)]

    return async () => {
      for (const cleanup of cleanups) await cleanup()
    }
  },
})
