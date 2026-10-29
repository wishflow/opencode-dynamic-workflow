---
name: odw
description: 把任务扇出给多个并发子会话（fan-out / 并行子 agent / 多步流水线 / 循环到通过）并汇总产物；单步任务、或仅在讨论机制时不用。
license: MIT
---

# ODW: dynamic workflows

ODW (opencode-dynamic-workflow) turns a repetitive multi-session job into one script. You write a small JS/TS program, the `odw_run` tool executes it, and every step of that program is a real opencode sub-session ("worker") with the normal tool set.

The script *is* the plan. Concurrency, budget, cancellation and the record of what happened belong to the plugin, so you do not babysit a fan-out turn by turn.

## 1. When to use it, when not to

Use it when the work is structurally repetitive:

| Shape | Example |
|---|---|
| fan-out over N items | "audit these 12 files", "summarise every package in this repo" |
| fan-out + combine | "check each package, then write one report" |
| pipeline | "summarise each file, then review each summary" |
| loop until it passes | "fix the failing tests, re-run, repeat until green" |
| heterogeneous multi-step | "collect, then verify, then decide" |

Do **not** use it when:

- the task is a single step ("read this file", "run this command", "explain X") - one tool call beats one script;
- the question is about the mechanism rather than a job to run - just answer;
- N is 2-3 and the fan-out overhead costs more than the work.

Width is money: every `ctx.agent` and `ctx.verify` is a real model turn on the user's account.

## 2. The flow

1. **Decide it is a workflow.** Name the N items and say what happens to each one.
2. **Dry-run with `odw_plan`**, passing the same arguments you will pass to `odw_run`. It compiles the script and checks literal `agent` / `model` / `effort` / `mode` / `permissions` values against the live inventory. No worker is created and nothing is spent.
3. **Read what the plan reported**, not just "ok": call sites it shows as `dynamic` (calls built inside `parallel` / `loop`) were never checked, and a mistyped `agent` name is caught here or not at all.
4. **Write the script.** `script:` takes inline source (preferred while iterating); `file:` takes a path relative to `<project>/workflows/`. All of `async (ctx) => {...}`, `(async (ctx) => {...})`, `async function workflow(ctx) {...}` and the same with a leading `export default` are accepted.
5. **`odw_run`.**
6. **Read progress, and on failure read the artifacts** - the error carries `kind` and `message`, the run directory carries the rest (section 6).
7. **Report honestly**: what ran, what it cost (`ctx.budget()`), and whether anything was actually verified. Never claim success from a script that never checked.

## 3. Primitives

The signatures and full semantics live in the `odw_plan` / `odw_run` tool descriptions, which are permanently in context - so this file does not repeat them. Short version:

| call | what it does | reach for it when |
|---|---|---|
| `ctx.agent({ prompt, ... })` | one worker session; returns its reply, or parsed JSON with `schema` | the unit of work |
| `ctx.parallel(items, fn, { concurrency })` | runs `fn` per item with bounded concurrency; results in input order | plain fan-out |
| `ctx.pipeline(items, ...stages)` | every item through the same stages, in order; items concurrent | fan-out plus a second pass |
| `ctx.loop({ max, body, until })` | up to `max` iterations, stops early when `until` is true | retry, or iterate to a condition |
| `ctx.verify(claim)` | read-only worker tries to falsify `claim`; returns `{ pass, reasons }` | before claiming the work is done |
| `ctx.checkpoint(label, data?)` | durable marker on disk | recording a decision worth keeping |
| `ctx.abort(reason?)` | ends the run on purpose | a precondition failed |
| `ctx.phase(name)` / `ctx.log(...)` | progress the user can see | long runs |
| `ctx.budget()` | `{ workers, cost, tokens, limitUsd }` | reporting cost |

`mode: "oneshot"` is worth reaching for: the worker has every tool denied and answers from the prompt alone, so it is much cheaper for "classify / rewrite / summarise this text" subtasks. It is only correct when everything the answer needs is already in the prompt.

## 4. Limits

| knob | default | maximum | behaviour at the cap |
|---|---|---|---|
| `concurrency` | 4 | 10 | caps workers in flight; extra items wait |
| `maxWorkers` | 50 | 10000 | the run stops starting new workers |
| `timeoutMs` | 600000 (10 min) | 24 h | the run stops |
| `budgetUsd` | none | - | the run stops starting new workers once spend exceeds it |
| primitive steps | 500 | - | the run stops |

When a cap is hit the run ends with an error naming that cap. A planned-but-never-started worker costs nothing.

## 5. Failures and retries

- A worker that fails **throws**, and the throw aborts the run. There is no automatic retry, so retry deliberately with `ctx.loop` (`until` = your success predicate, `max` mandatory).
- `ctx.parallel` stops dispatching new items on the first rejection, then surfaces the error.
- Retry only what is genuinely retryable (flaky tool, rate limit). If the loop runs into `max`, `stopped: "max"` means it never passed - report that, do not rewrite it as success.
- `ctx.verify` **fails closed**: a claim the verifier could not confirm is `pass: false`. Read `reasons` and either fix the work or loop again.
- `ctx.abort(reason)` is for a decision you made (bad precondition), not for an error you should handle.

## 6. Where the artifacts live

Every run writes `<project>/.odw/runs/<runId>/`:

| file | what it is |
|---|---|
| `script.ts` | the source exactly as it ran |
| `meta.json` | run metadata (arguments, session, inventory) |
| `journal.jsonl` | append-only event trail, written synchronously so a killed run still leaves a readable tail |
| `checkpoints/*.json` | one file per `ctx.checkpoint` |
| `result.json` | the final summary, once the run completes |

`runId` defaults to an auto, timestamp-prefixed id (pass your own with `runId`). The 50 most recent run directories are kept. Worker transcripts are *not* deleted: they stay in the session tree under this session's `parentID`, which is the primary evidence of what each worker did.

## 7. Complete examples

In the ODW repository itself, `workflows/audit.ts` is a worked example that uses the surface in its normal order (`pipeline` -> `checkpoint` -> `verify` -> `budget`) - run it with `odw_run({ file: "audit.ts" })`.

Elsewhere, this is a complete workflow:

```js
async (ctx) => {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"]
  const notes = await ctx.parallel(
    files,
    (f) => ctx.agent({ label: "read:" + f, prompt: "Read " + f + " and summarise it in 3 bullets." }),
    { concurrency: 4 },
  )
  return notes.join("\n\n")
}
```

A structured reply instead of prose, then a check before reporting:

```js
async (ctx) => {
  const out = await ctx.agent({
    label: "audit",
    prompt: "List every exported symbol in src/types.ts. Reply with JSON only.",
    schema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
  })
  const verdict = await ctx.verify("src/types.ts really exports these names: " + out.names.join(", "))
  return { names: out.names, verified: verdict.pass, reasons: verdict.reasons }
}
```

## 8. Common mistakes

- **Trying to reach the host from the script.** The sandbox has no `require`, `import`, `process`, `fetch`, `fs`, no network and no `eval`. Anything outside the script goes through `ctx.agent`.
- **Assuming the script can read.** The script cannot read a file or list a directory; make a worker do it and return the content.
- **`file:` is not a path from your cwd.** It resolves inside `<project>/workflows/`; a path that is not there fails.
- **`model` and `effort` together.** They are alternatives - `effort` is sugar for the inherited model's `#variant` - and giving both is an error, because two places would decide the same thing.
- **Dumping big data into `ctx.log` or a label.** Logs and labels are for humans; put data in `ctx.checkpoint` or in the return value.
- **Fanning out 50 tiny workers when 5 substantial ones would do.** Each worker is a full model turn.
- **Skipping `odw_plan`.** It is free, and it is the cheapest place to catch a mistyped `agent` / `model` name - the most common failure and the most expensive one, since it is otherwise discovered after the run has started spending.
- **Developing the plugin itself in the plugin's own repository.** Run opencode in a throwaway project: the server resolves its location from `PWD`, not from the child process's `cwd`.
