/**
 * The documentation the model reads: it is the `odw_run` tool description verbatim.
 *
 * Rules for this file (it is prompt, not comments):
 *  - document ONLY what M2 actually implements - an undocumented-but-mentioned
 *    primitive is worse than a missing one, because the model will call it;
 *  - show the exact `ctx` surface, since the sandbox offers nothing else;
 *  - keep the cost/latency warning loud, because every primitive call is a real
 *    model turn on the user's account.
 */

export const RUN_CONTEXT_SIGNATURE = `type RunContext = {
  agent<T = string>(o: {
    prompt: string                 // required, non-empty
    label?: string                 // shown in progress + artifacts
    agent?: string                 // opencode agent id, e.g. "explore" | "build"
    model?: string                 // "provider/model" or "provider/model#variant"
    mode?: "agentic" | "oneshot"   // default "agentic"
    permissions?: "inherit" | "read-only" | "dangerous-full-access"
    schema?: object                // JSON Schema; the reply is parsed as JSON
    timeoutMs?: number             // per-worker wall clock
  }): Promise<T>

  parallel<T, R>(
    items: T[],
    fn: (item: T, i: number) => Promise<R> | R,
    o?: { concurrency?: number }   // max items in flight, clamped to the run's concurrency
  ): Promise<R[]>

  log(...args: unknown[]): void
  phase(name: string): void
  budget(): { workers: number; cost: number; tokens: TokenTotals; limitUsd: number | null }
}`

export const ODW_RUN_DOC = `Run an opencode-dynamic-workflow script: a small JavaScript/TypeScript program that orchestrates opencode sub-sessions ("workers") deterministically.

WHY: when a task is "do the same thing to N items", "fan out and combine", or "loop until it passes", doing it turn-by-turn in one conversation is slow, serial and non-reproducible. Write the plan as a script and the plugin executes it: it controls concurrency, budget and cancellation, and it records every worker's transcript under this session.

## The script

The script must be a single expression evaluating to an async function of \`ctx\`. Preferred form:

\`\`\`js
async (ctx) => {
  await ctx.phase("collect")
  const files = ["a.ts", "b.ts"]
  const notes = await ctx.parallel(files, (f) => ctx.agent({
    label: "read:" + f,
    prompt: "Read " + f + " and summarise what it does in 3 bullets.",
  }), { concurrency: 4 })
  await ctx.phase("report")
  return notes.join("\\n\\n")
}
\`\`\`

\`export default\` is optional. The sandbox exposes exactly one argument; it has NO
\`require\`, \`import\`, \`process\`, \`fetch\`, \`fs\` or network access, and \`eval\` is
disabled. Anything that needs the outside world must go through \`ctx.agent\`,
because a worker is a real opencode session with the normal tool set.

${RUN_CONTEXT_SIGNATURE}

## Semantics

- \`ctx.agent\` creates a real sub-session (visible in the session tree under this
  one), sends the prompt, waits for it to settle, and returns the reply text - or
  the parsed JSON when \`schema\` is set. **A failed worker throws**, which aborts
  the script; there is no automatic retry, so retry deliberately with a loop if
  the task needs it.
- \`ctx.parallel\` runs \`fn\` for every item with bounded concurrency and resolves to
  the results in **input order**. The first rejection stops new items from being
  dispatched, then the error is thrown.
- \`ctx.phase\` marks progress. \`ctx.log\` records a line. Both are visible to the user.
- \`ctx.budget()\` reports what has been spent so far.

## Cost and limits

Every \`ctx.agent\` call is a real model turn on the user's account. A \`parallel\` over
50 items is 50 model turns. Prefer a few substantial workers over many tiny ones.
Runs are capped by \`concurrency\`, \`maxWorkers\`, \`budgetUsd\` and \`timeoutMs\`; when a
cap is hit the run stops with an error naming the cap.

## Parameters

- \`script\` - inline source (preferred while iterating).
- \`file\` - path to a script, relative to \`<project>/workflows/\`.
Everything else is optional: \`runId\`, \`concurrency\` (default 4, max 10),
\`timeoutMs\` (default 600000), \`budgetUsd\`, \`maxWorkers\` (default 50).
`
