/**
 * The documentation the model reads: it is the `odw_run` / `odw_plan` tool
 * description verbatim.
 *
 * Rules for this file (it is prompt, not comments):
 *  - document ONLY what actually exists - an undocumented-but-mentioned primitive
 *    is worse than a missing one, because the model will call it;
 *  - show the exact `ctx` surface, since the sandbox offers nothing else;
 *  - keep the cost/latency warning loud, because every `ctx.agent` call is a real
 *    model turn on the user's account.
 */

export const RUN_CONTEXT_SIGNATURE = `type RunContext = {
  agent<T = string>(o: {
    prompt: string                 // required, non-empty
    label?: string                 // shown in progress + artifacts
    agent?: string                 // opencode agent id, e.g. "explore" | "build"
    model?: string                 // "provider/model" or "provider/model#variant"
    effort?: string                // sugar for model's #variant; not with model
    mode?: "agentic" | "oneshot"   // oneshot = every tool denied, answer from the prompt
    permissions?: "inherit" | "read-only" | "dangerous-full-access"
    schema?: object                // JSON Schema; the reply is parsed as JSON
    timeoutMs?: number             // per-worker wall clock
  }): Promise<T>

  parallel<T, R>(
    items: T[],
    fn: (item: T, i: number) => Promise<R> | R,
    o?: { concurrency?: number }   // max items in flight, clamped to the run's concurrency
  ): Promise<R[]>

  pipeline<T, R = unknown>(
    items: T[],
    ...stages: Array<(input, item, i) => unknown>   // input = previous stage's value
  ): Promise<R[]>                  // stages run in order per item; items run concurrently

  loop<S = unknown>(o: {
    max: number                                      // required hard cap
    body: (state: S, i: number) => S | Promise<S>
    until?: (state: S, i: number) => boolean         // checked after each body run
    initial?: S
  }): Promise<{ iterations: number; state: S; stopped: "until" | "max" }>

  verify(claim: string | {
    claim: string
    evidence?: string              // untrusted hint; the verifier still checks it
    label?: string; agent?: string; model?: string; effort?: string
    permissions?: object | string  // default "read-only"
    timeoutMs?: number
  }): Promise<{ pass: boolean; reasons: string[] }>

  checkpoint(label: string, data?: unknown): Promise<void>   // durable marker
  abort(reason?: string): never                               // stop the run on purpose
  phase(name: string): void
  log(...args: unknown[]): void
  budget(): { workers: number; cost: number; tokens: TokenTotals; limitUsd: number | null }
}`

const HOW_IT_WORKS = `## The script

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
  the script; there is no automatic retry, so retry deliberately with \`ctx.loop\`
  if the task needs it.
- \`mode: "oneshot"\` is the same worker with **every tool denied**: it cannot read a
  file, run a command or call a sub-agent, so its answer comes from the prompt
  alone. Use it for "summarise/classify/rewrite this text" subtasks - it is far
  cheaper than a worker that goes exploring - and only when everything the answer
  needs is already in the prompt.
- \`effort\` and \`model\` are alternatives, not partners: \`effort: "high"\` sets the
  \`#variant\` of the inherited model. Giving both is an error, because two places
  would decide the same thing.
- \`ctx.parallel\` runs \`fn\` for every item with bounded concurrency and resolves to
  the results in **input order**. The first rejection stops new items from being
  dispatched, then the error is thrown.
- \`ctx.pipeline\` is \`parallel\` where each item also runs a chain of stages in
  order, each stage receiving the previous stage's value (\`(input, item, i)\`).
  It returns the **last** stage's value per item, in input order. Use it for
  "summarise each file, then review each summary" without nesting calls.
- \`ctx.loop\` runs \`body\` up to \`max\` times and stops early when \`until\` returns
  true. \`max\` is mandatory. It returns \`{iterations, state, stopped}\`.
- \`ctx.verify\` asks a **read-only** worker to falsify \`claim\` and returns
  \`{pass, reasons}\` - a boolean to branch on, not a paragraph to interpret. It
  **fails closed**: a claim the verifier could not confirm is \`pass: false\`. Use it
  before reporting work as done.
- \`ctx.checkpoint(label, data?)\` writes a durable marker (journal entry plus a
  file under the run's \`checkpoints/\`). Use it to record a decision worth keeping.
- \`ctx.abort(reason?)\` ends the run deliberately, with your reason.
- \`ctx.phase\` marks progress. \`ctx.log\` records a line. Both are visible to the user.
- \`ctx.budget()\` reports what has been spent so far.

## Cost and limits

Every \`ctx.agent\` and \`ctx.verify\` call is a real model turn on the user's account.
A \`parallel\` over 50 items is 50 model turns. Prefer a few substantial workers over
many tiny ones.

Runs are capped by \`concurrency\`, \`maxWorkers\`, \`budgetUsd\`, \`timeoutMs\` and the
primitive step budget (500 calls). When a cap is hit the run stops with an error
naming the cap.`

const PARAMETERS = `## Parameters

- \`script\` - inline source (preferred while iterating).
- \`file\` - path to a script, relative to \`<project>/workflows/\`.
Everything else is optional: \`runId\`, \`concurrency\` (default 4, max 10),
\`timeoutMs\` (default 600000), \`budgetUsd\`, \`maxWorkers\` (default 50).

## Workflow

1. \`odw_plan\` first - it compiles the script and checks literal \`agent\`/\`model\`/
   \`mode\`/\`permissions\` against the live inventory, for free.
2. \`odw_run\` to execute.
3. On failure, read \`kind\` + \`message\` + the artifacts directory, fix the script,
   and run again. Do not assume the first version succeeds.`

export const ODW_RUN_DOC = `Run an opencode-dynamic-workflow script: a small JavaScript/TypeScript program that orchestrates opencode sub-sessions ("workers") deterministically.

WHY: when a task is "do the same thing to N items", "fan out and combine", or "loop until it passes", doing it turn-by-turn in one conversation is slow, serial and non-reproducible. Write the plan as a script and the plugin executes it: it controls concurrency, budget and cancellation, and it records every worker's transcript under this session.

${HOW_IT_WORKS}

${PARAMETERS}
`

export const ODW_PLAN_DOC = `Dry-run an opencode-dynamic-workflow script. Compiles it, checks its arguments against the live agent/model inventory, and reports what it would do - **without creating a single worker and without spending anything**.

Use this before \`odw_run\` whenever the script is non-trivial. It is the cheap place to catch a mistyped \`agent\`/\`model\` (the most common failure, and an expensive one: a bad name is only discovered after the run has already started), an unimplemented \`mode\`, or a bad \`permissions\` value.

## What it checks

- resolves \`script\`/\`file\` exactly as \`odw_run\` would, and **compiles** it (syntax only);
- validates \`concurrency\` / \`timeoutMs\` / \`maxWorkers\` / \`budgetUsd\`;
- reads every **string literal** \`agent\` / \`model\` / \`effort\` / \`mode\` /
  \`permissions\` in \`ctx.agent({...})\` and \`ctx.verify({...})\` call sites and checks
  it against the inventory the run will actually use - including a model's
  \`#variant\` when the host reports its variant list;
- flags a call site that gives both \`model\` and \`effort\`;
- reports the session defaults and available agents/models.

## What it cannot check (and says so)

- the script is **not executed** and its body is **not invoked**: there is no
  simulation, so runtime failures, wrong logic and wrong worker counts stay hidden;
- non-literal arguments (\`agent: someVar\`, calls built inside \`parallel\`/\`loop\`)
  are reported as \`dynamic\` and never guessed at, so the real worker count of a
  fan-out is not predictable here;
- it cannot see what a worker will do.

A passing plan is not a promise that the run succeeds.

${PARAMETERS}
`
