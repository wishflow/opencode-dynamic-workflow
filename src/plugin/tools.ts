import type { Plugin } from "@opencode/plugin"

/**
 * M0 scaffolding: one liveness probe so that "the plugin loaded" and "a tool
 * really executed on the host server" are separately observable.
 */
export async function registerTools(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const registration = await ctx.tool.transform((editor) => {
    editor.add({
      name: "ping",
      description:
        "opencode-dynamic-workflow liveness probe. Returns the plugin's runtime binding to the host opencode server. Call it when verifying that the odw plugin is loaded and able to execute tools.",
      options: { namespace: "odw", codemode: true },
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => ({
        content: JSON.stringify({
          ok: true,
          pluginId: "odw",
          opencode: ctx.app.version,
          channel: ctx.app.channel,
          directory: ctx.location.directory,
          projectId: ctx.location.project.id,
        }),
      }),
    })
  })

  return () => registration.dispose()
}
