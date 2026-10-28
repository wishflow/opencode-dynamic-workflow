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
import { buildWorkerPrompt, describePermissions, resolvePermissions } from "./lifecycle.ts"
import { extractWorkerOutcome, type MessageLike } from "./result.ts"

export type WorkerEvent =
  | {
      type: "start"
      index: number
      label: string
      sessionID: string
      agent: string | null
      model: string | null
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
  /** Throws `WorkerLimitError` past `maxWorkers`; returns the 1-based worker ordinal. */
  claimWorker(): number
  onEvent(event: WorkerEvent): void
}

/**
 * Runs one agentic worker: a real opencode session, parented to the calling
 * session, driven to idle, then read back.
 *
 * Measured constraints this code encodes (PLAN §1 C5/C6/C7/C10):
 *  - `prompt` only enqueues; the turn is not started until `wait` is observed, and
 *    `context()` stays empty until the turn settles;
 *  - several workers can be prompted concurrently from inside a tool call - the
 *    concurrency mechanism is the worker `Semaphore`, not this function;
 *  - worker sessions are **not** removed afterwards: their transcripts are the
 *    evidence for what a run did, and `parentID` folds them in the session tree.
 */
export async function runAgenticWorker(deps: WorkerDeps, options: AgentOptions): Promise<WorkerOutcome> {
  const label = (options.label ?? "worker").trim() || "worker"

  deps.deadline.check(`worker ${label}`)
  assertNoModelCall(`worker ${label} 的 session.create`)
  if (deps.budget.exceeded()) {
    throw new BudgetExceededError(`worker ${label} 未启动：${deps.budget.describeLimit()}`)
  }

  // Validation deliberately precedes `claimWorker`: claiming is what increments the
  // run's "workers started" counter, and a typo'd agent never started anything.
  // Counting it would put a phantom worker in the summary and the artifacts.
  const workerModel = resolveWorkerModel(deps, options, label)
  const agent = options.agent ?? deps.defaultAgent ?? undefined
  if (agent && deps.knownAgents && !deps.knownAgents.has(agent)) {
    throw new OdwError(
      "bad-args",
      `未知 agent ${JSON.stringify(agent)}（worker ${label}）。可用：${[...deps.knownAgents].sort().join(", ")}`,
    )
  }
  const ordinal = deps.claimWorker()
  const permissions = resolvePermissions(options.permissions)
  const expectJson = options.schema !== undefined
  const promptText = buildWorkerPrompt(options.prompt, options.schema)

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
      permissions: describePermissions(options.permissions),
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
    })

    const onAbort = (): void => {
      void deps.ctx.session.interrupt({ sessionID }).catch(() => undefined)
    }
    deps.signal.addEventListener("abort", onAbort, { once: true })

    try {
      await deps.ctx.session.prompt({ sessionID, text: promptText })
      await waitForWorker(deps, sessionID, options.timeoutMs, label)
      if (deps.signal.aborted) throw new WorkflowAbortedError(`worker ${label} 在等待期间被取消`)

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

function resolveWorkerModel(deps: WorkerDeps, options: AgentOptions, label: string): ModelRef | null {
  if (!options.model) return deps.defaultModel
  const ref = parseModelRef(options.model)
  if (deps.knownModels && deps.knownModels.size > 0) {
    const key = `${ref.providerID}/${ref.id}`
    if (!deps.knownModels.has(key)) {
      throw new OdwError("bad-args", `未知 model ${JSON.stringify(options.model)}（worker ${label}）：不在当前可用模型清单里`)
    }
  }
  return ref
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
      throw new OdwError("timeout", `worker ${label} 超过 ${Math.round(budgetMs)}ms 仍未结束，已中断该会话`)
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function assertWorkerLimit(deps: WorkerDeps, ordinal: number): void {
  if (ordinal > deps.maxWorkers) {
    throw new WorkerLimitError(`已达到 maxWorkers=${deps.maxWorkers}：本次运行不会再启动新的 worker`)
  }
}
