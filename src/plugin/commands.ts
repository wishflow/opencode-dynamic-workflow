import { Plugin } from "@opencode/plugin"

/**
 * `/workflow <task>` - the human entry point.
 *
 * Two measured facts shape this file (CONTRACT.md §3.7):
 *
 *  1. Mutating `invocation.prompt.text` does **nothing**: the command produced no
 *     user message at all. A command that wants the model to see something must
 *     enqueue it itself, with `ctx.session.prompt({ sessionID, text })`.
 *     (Doing that from inside `command.execute` is verified re-entrant.)
 *  2. `opencode run "/workflow x"` does **not** dispatch a command - it sends the
 *     literal text as a user prompt. Commands are reached from the TUI or from
 *     `session.command`, so "headless" invocation goes through the *tool*
 *     (`odw_run`), not through this command.
 *
 * This command deliberately carries no workflow instructions of its own. The whole
 * how-to lives in the `odw` skill, which is the single source of truth for both
 * when to use ODW and how to drive it. Keeping a second copy here would drift.
 *
 * Like every other entry point, the command never runs a workflow itself: it hands
 * the model an instruction that says "load the skill, then use `odw_run`". Execution
 * stays a single code path - the tool - so there is exactly one place where workers
 * are created.
 */

export const WORKFLOW_COMMAND = "workflow"

export const WORKFLOW_USAGE = [
  "Usage: `/workflow <task description>`",
  "",
  "Example: `/workflow check that every script under workflows/ has header comments matching its implementation`",
  "",
  "`/workflow` executes nothing on its own. It hands the task to the model, which loads the",
  "`odw` skill and drives the `odw_run` tool. Execution happens in `odw_run`.",
].join("\n")

export function buildWorkflowDirective(task: string): string {
  return [
    task,
    "",
    "---",
    "The text above is the user's original request. Handle it with ODW dynamic workflows (the opencode-dynamic-workflow plugin).",
    "",
    "Start by loading the `odw` skill (skill tool, id `odw`). It carries everything you need: when ODW is the right tool and when it is not, the step-by-step process, the script primitives, the limits, complete examples, and the common mistakes.",
    "",
    "Then follow that skill: `odw_plan` for a free dry run, `odw_run` to execute.",
  ].join("\n")
}

export async function registerCommands(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const registration = await ctx.command.transform((editor) => {
    editor.add({
      name: WORKFLOW_COMMAND,
      description: "Run a task through an opencode-dynamic-workflow script (fans out worker sessions).",
      execute: async (invocation) => {
        const task = typeof invocation.prompt?.text === "string" ? invocation.prompt.text.trim() : ""
        // The command owns the prompt entirely - see the note above about
        // `prompt.text` mutation being a no-op.
        await ctx.session.prompt({
          sessionID: invocation.sessionID,
          text: task === "" ? WORKFLOW_USAGE : buildWorkflowDirective(task),
          metadata: { odw: { command: WORKFLOW_COMMAND, received: task } },
        })
      },
    })
  })

  return () => registration.dispose()
}
