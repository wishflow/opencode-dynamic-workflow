# opencode-dynamic-workflow (ODW)

[English](README.md) · [简体中文](README.zh-CN.md)

**Dynamic workflows as a first-class citizen in opencode v2**: the model writes a constrained script, the plugin runs it deterministically, and every worker is a real sub-session of the host opencode.

It exists for one shape of work: *do the same thing to N objects*, *fan out and then combine*, *loop until it passes*. Doing that turn by turn in a single session is slow, strictly serial and impossible to reproduce. Written as a script, concurrency, budget, cancellation and the record of what happened all belong to the plugin.

**ODW itself needs no API key.** Every model call happens inside a host opencode sub-session, using the login and provider credentials you already have.

```
model                  plugin (this repo)                    host opencode
 │                            │                                     │
 │ ① odw_plan (free dry run)  │                                     │
 ├───────────────────────────►│ compile the script + validate the    │
 │                            │ literal args (agent/model/effort/    │
 │                            │ mode/permissions) against live lists │
 │ ② odw_run(script)          │                                     │
 ├───────────────────────────►│ normalize -> node:vm sandbox         │
 │                            │   └─ run async (ctx) => {...}        │
 │                            │        ├─ ctx.agent       ───────────┼─► session.create(parentID)
 │                            │        ├─ ctx.parallel    ───────────┼─►   + prompt + wait
 │                            │        ├─ ctx.pipeline               │     (real sub-session, full tools)
 │                            │        ├─ ctx.loop / verify / ...    │
 │                            │        └─ structured error -> back to the model,
 │                            │           which decides whether to retry
 │ ③ read result.json         │                                     │
 │   / journal.jsonl          │                                     │
 │◄───────────────────────────┤                                     │
```

---

## Install

Requires opencode v2 (it loads TypeScript directly through its embedded Bun) and `node` on `PATH`. ODW has **zero runtime dependencies**.

### Global (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/wishflow/opencode-dynamic-workflow/main/scripts/odw-install.sh | sh -s -- --global
```

Or from a checkout, which uses the local files instead of downloading them:

```sh
./scripts/odw-install.sh install --global
```

The plugin goes in through opencode's own installer (`opencode plugin add github:wishflow/opencode-dynamic-workflow`), so it is recorded in your config the way opencode expects and the package is fetched eagerly. The script adds, around that:

| # | Action | Why in this order |
|---|---|---|
| 0 | Write the manifest `~/.config/opencode/.odw-migration.json` | **First**, before any mutation, so a failure halfway still leaves a usable `rollback` |
| 1 | Back up `opencode.json` -> `opencode.json.bak.<ts>` | Rollback needs the exact previous bytes |
| 2 | Clean up a legacy *project A* install: drop the deprecated `plugin` key, rename `plugins/odw.mjs` and `commands/{odw,ultracode,workflows}.md` to `*.disabled` | Renaming, never deleting; the config is updated before the files stop being referenced |
| 3 | `opencode plugin add <spec>` (one automatic retry) | It edits the config itself; the retry covers a real npm flake, see below |
| 4 | Write the skill `~/.config/opencode/skills/odw/SKILL.md` | Last, so the trigger surface only appears once the executor is there |

Then **restart opencode** (config and plugins are read at server start) and check:

```sh
opencode plugin list          # should show: odw  <commit>  github:wishflow/opencode-dynamic-workflow
```

> The retry in step 3 is not defensive noise: `opencode plugin add` failed on its first attempt in 2 of 3 observed runs, with transient registry errors (`No matching version found for @redis/json@6.3.1`, `Error: aborted`), and then succeeded immediately on retry.

### Project-local

```sh
./scripts/odw-install.sh install --local
```

opencode's CLI only ever edits the **global** config, so `--local` writes the project's `opencode.json` itself (merging into `plugins`, never replacing other keys) and puts the skill at `<project>/.opencode/skills/odw/SKILL.md`. It does **not** pre-fetch the package: opencode installs it in the background on its next start (about 2.5 minutes the first time, during which the plugin is not available yet).

```jsonc
// <project>/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:wishflow/opencode-dynamic-workflow"]
}
```

`opencode plugin list` only reflects the **global** config, so a project-local install has to be verified from the startup log instead (`msg="loading plugin" ... entrypoint=...`).

---

## Manage

```sh
./scripts/odw-install.sh status    [--global|--local]   # what is installed, and does it still match
./scripts/odw-install.sh update    [--global|--local]   # refresh the plugin and the skill
./scripts/odw-install.sh rollback  [--global|--local]   # undo, back to the previous bytes
```

`status` reports the scope, the config/skill/manifest paths, whether the plugin spec is registered, whether the skill still matches the digest recorded at install time, and whether a legacy install is still lying around. With no `--local` it also tells you whether the current project has a local install.

`update` refreshes the skill and runs `opencode plugin update` best-effort (that command needs a reachable opencode service; if it fails you get a warning, not a failed update).

`rollback` restores **files first and the config last**. That order is deliberate: restoring the config first opens a window where it names a plugin file that does not exist yet, and opencode's plugin registry reconcile hits it, logging a burst of `failed to load plugin ... ENOENT`.

`--ref <ref>` pins the download to a branch/tag instead of `main`.

---

## Migrating from the old plugin (project A)

The install script performs this migration; the table above is what it does. The short version of what changes:

| Old | New | Why |
|---|---|---|
| `opencode.json` -> `"plugin": ["./plugins/odw.mjs"]` | the `plugin` key is removed; `plugins: ["github:wishflow/..."]` is used instead | `plugin` is deprecated in v2 **and** points at a *file*; only a `<name>/index.ts` *directory* is discovered. The old key was also the source of a startup `WARN must be a directory` |
| `plugins/odw.mjs` (the V1 wrapper) | renamed `odw.mjs.disabled` | Kept on disk so `rollback` can restore it; nothing references it any more |
| `commands/{odw,ultracode,workflows}.md` | renamed `*.disabled` | `/odw` only said `workflow: $ARGUMENTS`; `ultracode`/`workflows` call tools that no longer exist. `/workflow` is re-registered by this plugin |
| `odw_ultracode` | **not carried over** | A global "ultracode" switch means any prompt might silently start an orchestration, which contradicts the design (execution is always explicit: `/workflow` or `odw_run`) |
| `odw_workflows` | **not carried over** | It read daemon state; ODW's record lives in `.odw/runs/<runId>/`, and two sources of truth is one too many |
| `~/.odw/config.json`, `odw-daemon` | not needed | ODW needs no key and runs no daemon |

If you installed the **old** plugin first, its own manifest is still on disk (`~/.config/opencode/.odw-migration.json`, written in an older format) and `install` will refuse rather than guess:

```text
odw-install: already installed (/Users/you/.config/opencode/.odw-migration.json). Run rollback first, or delete the manifest and reinstall.
```

That refusal is deliberate - the script will not overwrite a manifest whose shape it does not understand. Either roll the old install back first, or move that file aside and reinstall. `install` also refuses when *its own* manifest is present, for the same reason.

---

## How triggering works

**The trigger is a skill file, not a prompt injection.** ODW ships `skills/odw/SKILL.md`, and the installer copies it to where opencode discovers skills (`~/.config/opencode/skills/odw/SKILL.md` globally, `<project>/.opencode/skills/odw/SKILL.md` locally). opencode lists it with its *description*, and the model loads the body when the task matches:

```md
---
name: odw
description: 把任务扇出给多个并发子会话（fan-out / 并行子 agent / 多步流水线 / 循环到通过）并汇总产物；单步任务、或仅在讨论机制时不用。
---
```

(The shipped description is one Chinese sentence: *fan a task out across concurrent sub-sessions - fan-out, parallel sub-agents, multi-step pipelines, loop-until-it-passes - and summarise the artifacts; do not use it for a single-step task, or when merely discussing the mechanism.* The body of the skill is English.)

Design consequences worth knowing:

- the plugin registers **no prompt hook** and rewrites nothing you type - what the model sees is what you sent plus the skills opencode offers it;
- nothing runs automatically: the skill ends at calling `odw_plan` / `odw_run`, and both are ordinary tools that only do anything when the model (or you) calls them;
- *when* to use ODW lives in the description, *how* to drive it lives in the body, and both live in one file that reviewers can read like any other source file;
- the description is Chinese and the body English, but there is **no keyword list** anywhere: the model decides. Measured 2026-10-29 - the same fan-out request loaded the skill in English, Japanese and Korean alike, each producing a real run with `status: "ok"`.

---

## Usage

### `/workflow <task>`

The human entry point. It executes nothing itself: it hands the task to the model and asks it to load the `odw` skill, `odw_plan` first (free dry run) and then `odw_run`. Execution has exactly one code path - the tool - so there is exactly one place where workers are created.

```
/workflow check that every script under workflows/ has header comments matching its implementation
```

> Measured limitation: `opencode run "/workflow x"` does **not** dispatch a command; it sends the literal string as an ordinary user prompt. Commands are reached from the TUI or from `session.command`. Headless invocation should call `odw_run` directly.

### Tools (Code Mode)

| Tool | Code Mode path | Calls a model | What it does |
|---|---|:--:|---|
| plan | `tools.odw.plan` | **no** | Compiles the script and validates literal args against the live inventory; reports what *would* run |
| run | `tools.odw.run` | yes (inside the script only) | Actually runs the script |
| ping | `tools.odw.ping` | no | Liveness self-check |

```js
// tools.odw.run
{ script: 'async (ctx) => {...}' }   // inline source
{ file: "audit.ts" }                 // resolved inside <project>/workflows/
// optional: runId / concurrency (default 4, max 10) / timeoutMs (default 600000)
//           / budgetUsd / maxWorkers (default 50)
```

### What a script can use

Inside the sandbox there is `ctx` and nothing else:

| Primitive | What it does |
|---|---|
| `ctx.agent(o)` | Start a real sub-session, send a prompt, wait for it, return its text (or a parsed object when you pass a `schema`) |
| `ctx.parallel(items, fn, {concurrency?})` | Bounded fan-out; results come back **in input order** |
| `ctx.pipeline(items, ...stages)` | `parallel` plus a per-item chain of stages, each receiving the previous stage's value |
| `ctx.loop({max, body, until?, initial?})` | Iterate; `max` is required, `until` stops it early; returns `{iterations, state, stopped}` |
| `ctx.verify(claim \| o)` | An **adversarial** second opinion from a read-only worker; returns `{pass, reasons}`, and anything it cannot confirm is `pass: false` |
| `ctx.checkpoint(label, data?)` | Drop a durable marker (journal + a file under `checkpoints/`) |
| `ctx.abort(reason?)` | End this run deliberately |
| `ctx.phase(name)` / `ctx.log(...)` | Progress and logging |
| `ctx.budget()` | What has been spent so far |

The full option set of `ctx.agent`:

```ts
{
  prompt: string             // required, non-empty
  label?: string             // used in progress, the journal, the sub-session title
  agent?: string             // opencode agent id, e.g. "explore" | "build"
  model?: string             // "provider/model" or "provider/model#variant"
  effort?: string            // sugar for the model's #variant; cannot be combined with model
  mode?: "agentic" | "oneshot"   // oneshot = deny every tool
  permissions?: "inherit" | "read-only" | "dangerous-full-access" | Permission[]
  schema?: object            // JSON Schema; the reply is parsed as JSON
  timeoutMs?: number         // wall-clock for this one worker
}
```

**There is no automatic retry.** A failed worker raises, which stops the script; the tool hands a structured error (`kind` + `message` + the artifacts directory) back to the model, and the model edits the script and reruns it. Want retries? Write them with `ctx.loop`.

---

## The capability fence

Scripts run in `node:vm`, and the injected allowlist is **only** `ctx` plus a redirected `console`.

| Not in the sandbox | Which means |
|---|---|
| `require` / `import` / dynamic `import()` | A script cannot load any module |
| `process` / `fs` / `path` / `os` | No environment variables, no file access, no child processes |
| `fetch` / `XMLHttpRequest` / `WebSocket` | No network |
| `eval` / `new Function` | Blocked by `codeGeneration:{strings:false}` (measured: throws `EvalError`) |
| Timers / host globals | Not injected, not reachable |

**A capability fence is not a security boundary.** The threat model here is *the model writes wrong code*, not *an attacker gets arbitrary code execution*:

- `node:vm` is not a security sandbox, and escaping through the `constructor` chain is a known technique this tier does **not** defend against;
- so the correct usage is: **the model writes the script, you look at it, the plugin runs it** - not "run scripts from people you do not trust";
- the real defence against mistakes is not the isolation but the caps (next section) plus structured errors plus a record of every step;
- if real isolation is ever needed, the interface is already shaped to escalate to a `worker_threads` host (which can be `terminate()`d).

The fence is also a **startup check**: `vm` must support `runInContext({timeout})` and actually interrupt a pure-CPU infinite loop, or this tier does not hold. Measured on opencode 2.1.0 (embedded Bun 1.4.2): all four checks pass.

---

## Limits and budget

| Knob | Default | Notes |
|---|---|---|
| Wall clock per script | 10 min | Checked before every primitive call; synchronous infinite loops are interrupted by the vm `timeout` |
| Concurrency | **4** (max 10) | A script's `concurrency` can only lower it, never raise it |
| Total workers | **50** | Exceeding it raises `worker-limit`; it is **not** silently truncated |
| Primitive calls | **500** steps | Each `agent`/`parallel`/`pipeline`/`loop`/`verify`/`checkpoint`/`log`/`phase` costs 1 step. This guards the "free but runaway" case, e.g. `while(true) await ctx.log("x")` |
| Budget | counted only, by default | With `budgetUsd` it is enforced **after the fact**: spend accumulates as workers finish, and once over, no new worker is started (running ones are not killed) |
| Cancellation | `context.signal` | On cancel: stop dispatching -> `interrupt` -> `remove` |

> **Honest note (measured):** the *money* semantics of `budgetUsd` cannot be verified on free models - `compass/deepseek-v4.1-flash` reports `cost = 0` on every call (with non-zero token counts). So the "over budget, stop dispatching" path has unit coverage but no real-dollar evidence; token counting, `maxWorkers`, `maxSteps` and the concurrency cap all have real-machine evidence.

---

## `mode: "oneshot"`, honestly

`mode: "oneshot"` means "this turn, the worker can do nothing but talk":

- it is **not** a host-enforced single turn. opencode's `session.create` has no "disable tools" switch (checked against the generated types), so ODW denies every permission (`[{action:"*",resource:"*",effect:"deny"}]`, measured to land on the session row) and says so in the prompt;
- the model can still *try* to call a tool - it will be refused - and then has to answer from what the prompt already contains;
- measured: told to read a file, it replied that it has no file access and asked for the contents, and did **not** invent them;
- conversely, if the answer needs outside information, oneshot is the wrong tool; use the default `agentic`.

Same prompt, measured: `oneshot` 1.37s / 1050 input tokens vs `agentic` 1.58s / 2116 input tokens (agentic pays for the tool descriptions).

---

## Run artifacts

Every run leaves the evidence on disk under `<project>/.odw/runs/<runId>/`:

```
.odw/runs/<runId>/
├── script.ts          # the source actually executed (after normalization)
├── meta.json          # runId / sessionID / directory / origin / caps / scriptHost
├── journal.jsonl      # append-only event stream (run-start, worker-start, step, worker-end, run-end, ...)
├── result.json        # machine-readable result: workers/steps/cost/tokens/returnValue/humanSummary
└── checkpoints/       # files written by ctx.checkpoint (labels are sanitized against traversal)
```

**Worker sessions are not deleted.** Their transcripts are the primary evidence of what happened, and their `parentID` makes them foldable in your session tree.

---

## Layout

```
opencode-dynamic-workflow/
├── src/
│   ├── index.ts                    # Plugin.define({id:"odw", setup})
│   ├── types.ts                    # error family + AgentOptions/RunContext/ScriptHost contracts
│   ├── plugin/{tools,commands,guard}.ts
│   ├── script/{host,host-vm,normalize,api-doc,plan}.ts
│   ├── primitives/{agent,parallel,pipeline,loop,verify,index}.ts
│   ├── worker/{agentic,result,lifecycle}.ts
│   ├── runner/{runner,semaphore,budget,deadline,steps,journal}.ts
│   ├── params/model.ts
│   └── artifacts/store.ts
├── skills/odw/SKILL.md             # the trigger surface: when to use ODW, and how to drive it
├── scripts/odw-install.sh          # install / update / status / rollback (global, or --local)
├── tests/
│   ├── unit/                       # 84: primitives / steps / normalize / plan scanner / worker / skill
│   └── contract/opencode-v2/       # 62 assertions: probe + assert + harness + CONTRACT.md
├── workflows/audit.ts              # a `file:` carrier example (pipeline + checkpoint + verify)
└── README.md
```

---

## Known limitations

| Limitation | Detail |
|---|---|
| Commands cannot be triggered from `opencode run` | `opencode run "/workflow x"` sends the string as a prompt; use `odw_run` headlessly |
| `odw_plan` does not execute the script | It only reads **literals**: `agent: someVar`, or a call site built inside `parallel`/`loop`, is marked `dynamic` and skipped, so the real worker count is not predictable at plan time |
| A passing plan is not a passing run | Logic errors, runtime failures and worker counts are all invisible to it |
| Free models report no money | See the honest note under Limits |
| A worker inherits the session's model | Unless the script passes `model` (or `effort`) on that call. If the session runs on a free tier, every worker hits the provider quota and the run fails with `kind: "internal"` - pass `--model` explicitly when you drive ODW from `opencode run` |
| The old `odw_ultracode` / `odw_workflows` are not carried over | Two sources of truth is one too many; the old commands are renamed, not deleted, so this is reversible |

---

## Development

```sh
npx tsc --noEmit                               # type check (no build step, no transpiled output)
npx vitest run tests/unit                      # 84 unit tests
ODW_CONTRACT=1 npx vitest run tests/contract   # 62 contract assertions (starts real opencode)
node tests/contract/opencode-v2/run.mjs --keep # keep the artifacts for debugging
```

The contract suite is a **behaviour snapshot taken by running opencode itself** (`tests/contract/opencode-v2/CONTRACT.md`), not a mock: it creates a throwaway git project, plants its probe and a skill fixture, spawns `opencode run`, and asserts the raw observations. It never reads or writes your `~/.config/opencode`.

**The one rule of the development loop: never run opencode inside this repository.** It would auto-discover the plugin and reload it on every edit. The contract harness already does the right thing (`mkdtemp` -> `git init` -> plant the fixture -> `spawnSync("opencode", ...)` with `PWD` explicitly set to the throwaway project; setting only `cwd` silently binds the server to the wrong project).

---

## License

MIT - see [LICENSE](LICENSE).
