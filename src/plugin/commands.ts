import type { Plugin } from "@opencode/plugin"

/**
 * `/workflow <任务>` - the human entry point.
 *
 * Two measured facts shape this file (PLAN §1 C17/C18, CONTRACT.md §3.7):
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
 * Like the prompt hook (D6), this command never runs a workflow itself: it hands
 * the model an instruction that says "use `odw_run`". Execution stays a single
 * code path - the tool - so there is exactly one place where workers are created.
 */

export const WORKFLOW_COMMAND = "workflow"

export const WORKFLOW_USAGE = [
  "用法：`/workflow <任务描述>`",
  "",
  "例：`/workflow 核查 workflows/ 下每个脚本的头部注释是否和实现一致`",
  "",
  "说明：`/workflow` 不会自己执行任何东西，它只是把任务交给模型，并要求模型用 `odw_run` 写一个",
  "脚本、并行起 worker 会话、最后汇总结果。真正执行的是 `odw_run` 工具。",
].join("\n")

export function buildWorkflowDirective(task: string): string {
  return [
    task,
    "",
    "---",
    "上面是用户的原始请求。请用 ODW 动态工作流（opencode-dynamic-workflow 插件）完成它。流程：",
    "",
    "1. **先拆解**：把请求拆成若干独立、可并行的子任务。每个子任务写清「给 worker 的完整指令」——",
    "   worker 看不到我们这段对话，指令必须自洽（点名文件、给出判断标准、说明输出格式）。",
    "2. **写脚本执行**：调用 `odw_run` 工具（Code Mode 里是 `tools.odw.run`）。脚本是一个求值为",
    "   `async (ctx) => {...}` 的表达式，只能用 `ctx.agent` / `ctx.parallel` / `ctx.log` / `ctx.phase` / `ctx.budget`；",
    "   沙箱里没有 `require`/`import`/`fs`/`process`/`fetch`。需要读写文件就在 `ctx.agent` 的指令里让 worker 去做。",
    "3. **省着花**：每个 `ctx.agent` 都是一次真实模型调用。宁可少而实（几个内容充实的 worker），",
    "   不要把任务切成一堆碎片 worker。需要 JSON 结果就传 `schema`，不要靠模型自觉。",
    "4. **允许失败重试**：脚本失败时工具会返回结构化错误（`kind` + `message`）和现场目录；",
    "   据此改脚本重跑。不要在第一版脚本上假设一次就成功。",
    "5. **汇总收尾**：把 worker 的结果整理成对人可读的答复，附上 `runId` 与关键 worker 的结论。",
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
