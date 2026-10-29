import type { Plugin } from "@opencode/plugin"

import { formatModelRef, parseModelRef } from "../params/model.ts"
import { assertNoModelCall } from "../plugin/guard.ts"
import type { Budget } from "../runner/budget.ts"
import type { Deadline } from "../runner/deadline.ts"
import type { Journal } from "../runner/journal.ts"
import type { Semaphore } from "../runner/semaphore.ts"
import {
  BudgetExceededError,
  OdwError,
  WorkerLimitError,
  WorkflowAbortedError,
  type AgentOptions,
  type ModelRef,
  type WorkerOutcome,
} from "../types.ts"
import {
  buildOneshotPrompt,
  buildWorkerPrompt,
  describePermissions,
  resolvePermissions,
  DENY_ALL_RULES,
  type WorkerMode,
} from "./lifecycle.ts"
import { extractWorkerOutcome, type MessageLike } from "./result.ts"

export type { WorkerMode }

export type WorkerEvent =
  | {
      type: "start"
      index: number
      label: string
      sessionID: string
      agent: string | null
      model: string | null
      mode: WorkerMode
      permissions: string
      live: number
      queued: number
    }
  | { type: "done"; outcome: WorkerOutcome; live: number; queued: number }

export type WorkerDeps = {
  readonly ctx: Plugin.Context
  /** Model inherited from the calling session; per-worker `model` overrides it. */
  readonly defaultModel: ModelRef | null
  readonly defaultAgent: string | null
  readonly parentSessionID: string
  readonly semaphore: Semaphore
  readonly deadline: Deadline
  readonly budget: Budget
  readonly journal: Journal
  readonly signal: AbortSignal
  readonly maxWorkers: number
  /** Known inventory, used to fail fast on a typo instead of at session.create. */
  readonly knownAgents: ReadonlySet<string> | null
  readonly knownModels: ReadonlySet<string> | null
  /** `"provider/model"` -> its variant ids, when the host reports them. */
  readonly modelVariants: ReadonlyMap<string, ReadonlySet<string>> | null
  /** Throws `WorkerLimitError` past `maxWorkers`; returns the 1-based worker ordinal. */
  claimWorker(): number
  onEvent(event: WorkerEvent): void
}

/**
 * Runs one worker: a real opencode session, parented to the calling session,
 * driven to idle, then read back.
 *
 * `mode` picks the posture, not the plumbing:
 *  - `"agentic"` (default) gives the worker its normal tools, so it can read the
 *    repo and act on it;
 *  - `"oneshot"` denies every tool and says so in the prompt, so the answer comes
 *    from the prompt alone. That is a *posture*, not a host-enforced single turn:
 *    `session.create` has no tool-disable flag (checked against the generated
 *    types), so a one-shot worker can still attempt a call - it is denied, and it
 *    still has to answer.
 *
 * Measured constraints this code encodes (PLAN §1 C5/C6/C7/C10):
 *  - `prompt` only enqueues; the turn is not started until `wait` is observed, and
 *    `context()` stays empty until the turn settles;
 *  - several workers can be prompted concurrently from inside a tool call - the
 *    concurrency mechanism is the worker `Semaphore`, not this function;
 *  - worker sessions are **not** removed afterwards: their transcripts are the
 *    evidence for what a run did, and `parentID` folds them in the session tree.
 */
export async function runWorker(deps: WorkerDeps, options: AgentOptions): Promise<WorkerOutcome> {
  const label = (options.label ?? "worker").trim() || "worker"

  deps.deadline.check(`worker ${label}`)
  assertNoModelCall(`session.create for worker ${label}`)
  if (deps.budget.exceeded()) {
    throw new BudgetExceededError(`worker ${label} not started: ${deps.budget.describeLimit()}`)
  }

  // Validation deliberately precedes `claimWorker`: claiming is what increments the
  // run's "workers started" counter, and a typo'd agent never started anything.
  // Counting it would put a phantom worker in the summary and the artifacts.
  const mode = resolveMode(options.mode, label)
  const { ref: workerModel, source: variantSource } = resolveWorkerModel(deps, options, label)
  const agent = options.agent ?? deps.defaultAgent ?? undefined
  if (agent && deps.knownAgents && !deps.knownAgents.has(agent)) {
    throw new OdwError(
      "bad-args",
      `unknown agent ${JSON.stringify(agent)} (worker ${label}). Available: ${[...deps.knownAgents].sort().join(", ")}`,
    )
  }
  const ordinal = deps.claimWorker()
  // A one-shot worker denies everything unless the script asked for something
  // explicitly; the default here is the whole point of the mode.
  const permissions =
    options.permissions === undefined && mode === "oneshot"
      ? DENY_ALL_RULES
      : resolvePermissions(options.permissions)
  const expectJson = options.schema !== undefined
  const promptText =
    mode === "oneshot" ? buildOneshotPrompt(options.prompt, options.schema) : buildWorkerPrompt(options.prompt, options.schema)

  return deps.semaphore.run(async () => {
    const started = Date.now()
    const created = await deps.ctx.session.create({
      title: `odw ${label}`,
      parentID: deps.parentSessionID,
      ...(agent === undefined ? {} : { agent }),
      ...(workerModel === null ? {} : { model: workerModel }),
      ...(permissions === undefined ? {} : { permissions }),
    })
    const sessionID = created.id

    deps.onEvent({
      type: "start",
      index: ordinal,
      label,
      sessionID,
      agent: agent ?? null,
      model: workerModel === null ? null : formatModelRef(workerModel),
      mode,
      permissions: describePermissions(options.permissions, mode),
      live: deps.semaphore.inFlight,
      queued: deps.semaphore.queued,
    })
    deps.journal.append({
      type: "worker-start",
      index: ordinal,
      label,
      sessionID,
      agent: agent ?? null,
      model: workerModel === null ? null : formatModelRef(workerModel),
      mode,
      variantSource,
    })

    const onAbort = (): void => {
      void deps.ctx.session.interrupt({ sessionID }).catch(() => undefined)
    }
    deps.signal.addEventListener("abort", onAbort, { once: true })

    try {
      await deps.ctx.session.prompt({ sessionID, text: promptText })
      await waitForWorker(deps, sessionID, options.timeoutMs, label)
      if (deps.signal.aborted) throw new WorkflowAbortedError(`worker ${label} was cancelled while waiting`)

      const messages = (await deps.ctx.session.context({ sessionID })) as readonly MessageLike[]
      const outcome = extractWorkerOutcome(messages, {
        index: ordinal,
        label,
        sessionID,
        elapsedMs: Date.now() - started,
        expectJson,
      })
      deps.budget.record(outcome.usage)
      deps.journal.append({
        type: "worker-done",
        index: ordinal,
        label,
        sessionID,
        ok: outcome.ok,
        elapsedMs: outcome.elapsedMs,
        tokens: outcome.usage.tokens,
        cost: outcome.usage.cost,
        replyHead: outcome.text.slice(0, 400),
        failure: outcome.failure ?? null,
      })
      deps.onEvent({ type: "done", outcome, live: deps.semaphore.inFlight, queued: deps.semaphore.queued })
      return outcome
    } catch (error) {
      if (error instanceof WorkflowAbortedError || error instanceof BudgetExceededError) {
        deps.journal.append({ type: "worker-error", index: ordinal, label, sessionID, error: String(error) })
        throw error
      }
      const failure = {
        kind: "internal" as const,
        message: error instanceof Error ? error.message : String(error),
      }
      const outcome: WorkerOutcome = {
        index: ordinal,
        label,
        sessionID,
        ok: false,
        text: "",
        usage: { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
        failure,
        elapsedMs: Date.now() - started,
      }
      deps.journal.append({ type: "worker-error", index: ordinal, label, sessionID, error: failure.message })
      deps.onEvent({ type: "done", outcome, live: deps.semaphore.inFlight, queued: deps.semaphore.queued })
      return outcome
    } finally {
      deps.signal.removeEventListener("abort", onAbort)
    }
  })
}

/**
 * Exported for the unit tests: mode/model/variant resolution is where a mistyped
 * argument is either caught for free or turned into a wasted `session.create`.
 */
export function resolveMode(mode: string | undefined, label: string): WorkerMode {
  if (mode === undefined) return "agentic"
  if (mode === "agentic" || mode === "oneshot") return mode
  throw new OdwError("bad-args", `unknown mode ${JSON.stringify(mode)} (worker ${label}): use "agentic" or "oneshot"`)
}

/**
 * Locates the model for a worker and validates it, including its variant.
 *
 * `model` and `effort` are mutually exclusive on purpose: `#variant` in a model
 * ref and a separate `effort` field are two ways to say the same thing, and
 * accepting both would make "which one won" a question the run journal has to
 * answer. `effort` is therefore sugar - it sets the variant of the inherited
 * model - and only when no explicit model was given.
 */
export function resolveWorkerModel(
  deps: WorkerDeps,
  options: AgentOptions,
  label: string,
): { ref: ModelRef | null; source: "model" | "effort" | "inherited" } {
  if (options.effort !== undefined && options.model !== undefined) {
    throw new OdwError(
      "bad-args",
      `worker ${label} was given both model and effort: use only one (effort sets the model's #variant,` +
        `two sources of truth will disagree)`,
    )
  }
  if (options.effort === undefined && options.model === undefined) {
    return { ref: deps.defaultModel, source: "inherited" }
  }

  let ref: ModelRef
  if (options.effort !== undefined) {
    if (typeof options.effort !== "string" || options.effort.trim() === "") {
      throw new OdwError("bad-args", `worker ${label} needs effort to be a non-empty string`)
    }
    if (deps.defaultModel === null) {
      throw new OdwError(
        "bad-args",
        `worker ${label} asked for effort but there is no default model to inherit, so ${JSON.stringify(options.effort)} cannot be checked: pass model explicitly`,
      )
    }
    ref = { ...deps.defaultModel, variant: options.effort.trim() }
  } else {
    ref = parseModelRef(options.model ?? "")
  }

  const key = `${ref.providerID}/${ref.id}`
  if (deps.knownModels && deps.knownModels.size > 0 && !deps.knownModels.has(key)) {
    throw new OdwError(
      "bad-args",
      `unknown model ${JSON.stringify(options.model ?? key)} (worker ${label}): not in the available model list`,
    )
  }

  // Variants are only checked when the host actually reports them for this model;
  // an empty list means "unknown", not "none allowed".
  const allowed = deps.modelVariants?.get(key)
  if (allowed !== undefined && allowed.size > 0 && ref.variant !== "default" && !allowed.has(ref.variant)) {
    throw new OdwError(
      "bad-args",
      `unknown variant ${JSON.stringify(ref.variant)} (worker ${label}, model ${key}). Available: ${[...allowed].sort().join(", ")}`,
    )
  }

  return { ref, source: options.effort === undefined ? "model" : "effort" }
}

/**
 * Waits for a worker to go idle.
 *
 * `session.wait` has no timeout of its own, so a worker that never settles would
 * hang the whole run. The race is what makes `timeoutMs` meaningful; the interrupt
 * afterwards is what stops the abandoned turn from billing further.
 */
async function waitForWorker(deps: WorkerDeps, sessionID: string, timeoutMs: number | undefined, label: string): Promise<void> {
  const budgetMs = Math.max(1, Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, deps.deadline.remainingMs()))
  if (!Number.isFinite(budgetMs)) {
    await deps.ctx.session.wait({ sessionID })
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs)
  })
  try {
    const result = await Promise.race([deps.ctx.session.wait({ sessionID }).then(() => "done" as const), timedOut])
    if (result === "timeout") {
      await deps.ctx.session.interrupt({ sessionID }).catch(() => undefined)
      throw new OdwError("timeout", `worker ${label} did not finish within ${Math.round(budgetMs)}ms; the session was interrupted`)
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function assertWorkerLimit(deps: WorkerDeps, ordinal: number): void {
  if (ordinal > deps.maxWorkers) {
    throw new WorkerLimitError(`maxWorkers=${deps.maxWorkers} reached: this run will not start more workers`)
  }
}
