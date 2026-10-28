import { readFileSync } from "node:fs"
import { isAbsolute, join, resolve, sep } from "node:path"

import type { Plugin } from "@opencode/plugin"

import { createRunArtifacts, defaultArtifactsRoot, pruneRuns, type RunArtifacts } from "../artifacts/store.ts"
import { createRunContext } from "../primitives/index.ts"
import { createScriptHost } from "../script/host.ts"
import type { ScriptRunOptions } from "../script/host.ts"
import {
  OdwError,
  WorkerLimitError,
  WorkflowAbortedError,
  toScriptError,
  type ModelRef,
  type RunContext,
  type ScriptError,
  type ScriptResult,
  type WorkerOutcome,
} from "../types.ts"
import { assertNoModelCall } from "../plugin/guard.ts"
import { Budget } from "./budget.ts"
import { Deadline } from "./deadline.ts"
import { Journal } from "./journal.ts"
import { DEFAULT_MAX_STEPS, Steps } from "./steps.ts"
import { Semaphore } from "./semaphore.ts"
import { runAgenticWorker, type WorkerDeps, type WorkerEvent } from "../worker/agentic.ts"

export const DEFAULTS = {
  concurrency: 4,
  maxConcurrency: 10,
  timeoutMs: 600_000,
  maxWorkers: 50,
  maxSteps: DEFAULT_MAX_STEPS,
  keepRuns: 50,
  progressIntervalMs: 500,
} as const

export const WORKFLOW_DIR = "workflows"

export type RunWorkflowInput = {
  script?: string | undefined
  file?: string | undefined
  runId?: string | undefined
  concurrency?: number | undefined
  timeoutMs?: number | undefined
  budgetUsd?: number | undefined
  maxWorkers?: number | undefined
}

export type RunWorkflowDeps = {
  readonly ctx: Plugin.Context
  /** The session that invoked the tool: workers become its children. */
  readonly sessionID: string
  readonly directory: string
  readonly signal: AbortSignal
  /**
   * Live progress channel (TUI metadata).
   *
   * Optional on purpose: contract C12 only pins that `toolContext.progress` is
   * callable, and it is *not* re-exported to a Code Mode bridge call, which is how
   * `odw_run` is normally reached. A missing channel costs nothing (the journal and
   * synthetic messages are the durable record), whereas trusting it blindly would
   * throw a `TypeError` on every emit.
   */
  readonly progress?: ((update: Record<string, unknown>) => Promise<void> | void) | undefined
}

export type RunWorkflowResult = {
  readonly runId: string
  readonly status: "ok" | "error"
  readonly humanSummary: string
  readonly metadata: Record<string, unknown>
}

/**
 * Executes one workflow run end to end.
 *
 * Ordering matters here and mirrors PLAN §7: the script text and metadata are
 * persisted *before* anything executes, so a run that dies mid-flight is still
 * diagnosable from disk alone.
 */
export async function runWorkflow(deps: RunWorkflowDeps, input: RunWorkflowInput): Promise<RunWorkflowResult> {
  assertNoModelCall("odw_run")

  const runId = resolveRunId(input.runId)
  const concurrency = clampInt(input.concurrency ?? DEFAULTS.concurrency, 1, DEFAULTS.maxConcurrency)
  const timeoutMs = clampInt(input.timeoutMs ?? DEFAULTS.timeoutMs, 1_000, 24 * 60 * 60 * 1000)
  const maxWorkers = clampInt(input.maxWorkers ?? DEFAULTS.maxWorkers, 1, 10_000)

  const resolved = resolveScriptSource(input, deps.directory)
  const artifactsRoot = defaultArtifactsRoot(deps.directory)
  const artifacts = createRunArtifacts(artifactsRoot, runId)
  artifacts.write("script.ts", `${resolved.source}\n`)
  artifacts.writeJson("meta.json", {
    runId,
    startedAt: new Date().toISOString(),
    sessionID: deps.sessionID,
    directory: deps.directory,
    origin: resolved.origin,
    concurrency,
    timeoutMs,
    maxWorkers,
    budgetUsd: input.budgetUsd ?? null,
    scriptHost: `${createScriptHost().implementation} (tier A)`,
  })

  const journal = new Journal(join(artifacts.dir, "journal.jsonl"))
  journal.append({
    type: "run-start",
    runId,
    origin: resolved.origin,
    concurrency,
    timeoutMs,
    maxWorkers,
    // Recorded because a missing channel is otherwise invisible: it is silently
    // swallowed rather than failing, and that is exactly the kind of thing you
    // want to be able to read back from the artifacts.
    progressChannel: typeof deps.progress === "function" ? "tool" : "none",
  })

  const budget = new Budget(input.budgetUsd)
  const deadline = Deadline.after(timeoutMs)
  const steps = new Steps(DEFAULTS.maxSteps)
  const workerSemaphore = new Semaphore(concurrency)
  const startedAt = Date.now()

  const progress = createProgressChannel(deps)
  let checkpoints = 0
  const checkpointNames: string[] = []

  // Cancellation has three sources (caller abort, wall-clock timeout, deadline
  // inside a primitive) and one destination: every worker session gets interrupted.
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  deps.signal.addEventListener("abort", onOuterAbort, { once: true })
  const wallClock = setTimeout(() => controller.abort(), timeoutMs)

  let workersStarted = 0
  const workerEvents: WorkerOutcome[] = []
  const record = (outcome: WorkerOutcome): void => {
    workerEvents.push(outcome)
  }

  const workerDeps: WorkerDeps = {
    ctx: deps.ctx,
    defaultModel: null,
    defaultAgent: null,
    parentSessionID: deps.sessionID,
    semaphore: workerSemaphore,
    deadline,
    budget,
    journal,
    signal: controller.signal,
    maxWorkers,
    knownAgents: null,
    knownModels: null,
    claimWorker: () => {
      // The check comes before the increment for the same reason validation does in
      // `runAgenticWorker`: a refused worker never started, so it must not appear in
      // the run's worker count/summary.
      if (workersStarted + 1 > maxWorkers) {
        throw new WorkerLimitError(`已达到 maxWorkers=${maxWorkers}：本次运行不会再启动新的 worker`)
      }
      workersStarted += 1
      return workersStarted
    },
    onEvent: (event: WorkerEvent) => handleWorkerEvent(event, record, progress),
  }

  // Inventory + session defaults are ordinary (non-model) API calls. They are
  // best-effort: a read failure only costs the fast-fail typo check.
  const { defaults, knownAgents, knownModels } = await loadInventory(deps)

  const boundWorkerDeps: WorkerDeps = {
    ...workerDeps,
    defaultModel: defaults.model,
    defaultAgent: defaults.agent,
    knownAgents,
    knownModels,
  }

  const runContext = createRunContext({
    worker: boundWorkerDeps,
    deadline,
    budget,
    steps,
    concurrency,
    log: (message) => {
      journal.append({ type: "log", message })
      progress.emit({ phase: "log", message, workers: budget.workers, cost: budget.cost }, false)
    },
    phase: (name) => {
      journal.append({ type: "phase", name })
      // A phase is a milestone the user should always see, so it is never throttled.
      progress.emit({ phase: name, workers: budget.workers, cost: budget.cost, done: workerEvents.length }, true)
      void deps.ctx.session
        .synthetic({ sessionID: deps.sessionID, text: `[odw ${runId}] ▸ ${name}` })
        .catch(() => undefined)
    },
    checkpoint: (label, data) => {
      checkpoints += 1
      // The label is script-authored, so it is sanitised before it becomes a file
      // name: `"../../x"` must not be able to escape the run directory.
      const safe = sanitizeLabel(label)
      const name = `checkpoints/${String(checkpoints).padStart(3, "0")}-${safe}.json`
      const entry = { runId, label, at: new Date().toISOString(), data: data ?? null }
      let path: string
      let dataBytes: number | null = null
      try {
        const serialized = JSON.stringify(entry, null, 2)
        dataBytes = serialized.length
        path = artifacts.write(name, `${serialized}\n`)
      } catch {
        // A circular or otherwise unserialisable payload must not fail the run;
        // the marker itself is the durable part.
        path = artifacts.write(name, `${JSON.stringify({ runId, label, at: new Date().toISOString(), data: null, dataUnserializable: true }, null, 2)}\n`)
      }
      checkpointNames.push(path)
      journal.append({ type: "checkpoint", label, path, dataBytes, workers: budget.workers, cost: budget.cost })
      // Never synthetic: a script may legitimately checkpoint often, and the file
      // plus journal entry is what makes it durable - not a chat line.
      progress.emit({ phase: "checkpoint", label, workers: budget.workers, cost: budget.cost }, false)
    },
  })

  let scriptResult: ScriptResult
  try {
    scriptResult = await runScriptWithWallClock(resolved.source, runContext, {
      timeoutMs,
      syncTimeoutMs: Math.min(timeoutMs, 10_000),
      signal: controller.signal,
      filename: `${runId}/workflow.ts`,
    })
  } catch (error) {
    scriptResult = { status: "error", error: toScriptError(error), elapsedMs: Date.now() - startedAt }
  } finally {
    clearTimeout(wallClock)
    deps.signal.removeEventListener("abort", onOuterAbort)
  }

  const elapsedMs = Date.now() - startedAt
  const failed = workerEvents.filter((outcome) => !outcome.ok)
  const snapshot = budget.snapshot()

  const metadata: Record<string, unknown> = {
    runId,
    status: scriptResult.status,
    elapsedMs,
    workers: { started: workersStarted, settled: workerEvents.length, failed: failed.length },
    steps: { used: steps.count, limit: steps.limit },
    checkpoints: checkpointNames,
    cost: snapshot.cost,
    tokens: snapshot.tokens,
    artifactsDir: artifacts.dir,
    scriptHost: "node:vm",
    journalPath: join(artifacts.dir, "journal.jsonl"),
    workerSessions: workerEvents
      .filter((outcome) => outcome.sessionID !== undefined)
      .map((outcome) => ({ label: outcome.label, sessionID: outcome.sessionID, ok: outcome.ok })),
  }

  let humanSummary: string
  let status: "ok" | "error"
  if (scriptResult.status === "ok") {
    status = "ok"
    metadata["returnValue"] = truncateValue(scriptResult.returnValue)
    humanSummary = summarizeOk(runId, scriptResult.returnValue, {
      started: workersStarted,
      failed: failed.length,
      elapsedMs,
      cost: snapshot.cost,
      tokens: snapshot.tokens.input + snapshot.tokens.output + snapshot.tokens.reasoning,
      artifactsDir: artifacts.dir,
    })
  } else {
    status = "error"
    metadata["error"] = scriptResult.error
    humanSummary = summarizeError(runId, scriptResult.error, {
      started: workersStarted,
      failed: failed.length,
      elapsedMs,
      cost: snapshot.cost,
      artifactsDir: artifacts.dir,
    })
  }

  journal.append({
    type: "run-end",
    runId,
    status,
    elapsedMs,
    started: workersStarted,
    failed: failed.length,
    stepsUsed: steps.count,
    checkpoints: checkpoints,
    cost: snapshot.cost,
    error: scriptResult.status === "error" ? scriptResult.error : null,
  })
  artifacts.writeJson("result.json", { ...metadata, humanSummary })
  pruneRuns(artifactsRoot, DEFAULTS.keepRuns)

  progress.emit(
    { phase: status === "ok" ? "done" : "failed", workers: workersStarted, cost: snapshot.cost, elapsedMs },
    true,
  )
  await progress.drain()
  await deps.ctx.session
    .synthetic({
      sessionID: deps.sessionID,
      text: `[odw ${runId}] ${status === "ok" ? "✅ 完成" : "❌ 失败"}：${workersStarted} workers，${failed.length} 失败，${(elapsedMs / 1000).toFixed(1)}s，$${snapshot.cost.toFixed(4)}`,
    })
    .catch(() => undefined)

  return { runId, status, humanSummary, metadata }
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

type ScriptSource = { source: string; origin: { kind: "inline" } | { kind: "file"; path: string } }

export type { ScriptSource }

/**
 * Resolves `script` (inline) or `file` (inside `<project>/workflows/`) to source
 * text. Exported because `odw_plan` must run the *identical* resolution the run
 * would, or the dry run would validate a different script than the one executed.
 */
export function resolveScriptSource(input: RunWorkflowInput, directory: string): ScriptSource {
  const inline = typeof input.script === "string" ? input.script.trim() : ""
  if (inline !== "") return { source: inline, origin: { kind: "inline" } }

  const file = typeof input.file === "string" ? input.file.trim() : ""
  if (file === "") {
    throw new OdwError("bad-args", "必须提供 script（内联源码）或 file（workflows/ 下的脚本路径）")
  }
  const base = resolve(directory, WORKFLOW_DIR)
  const path = isAbsolute(file) ? resolve(file) : resolve(base, file)
  if (!isAbsolute(file) && path !== base && !path.startsWith(base + sep)) {
    throw new OdwError("bad-args", `file 必须位于 ${WORKFLOW_DIR}/ 之内（收到 ${JSON.stringify(file)}）`)
  }
  try {
    return { source: readFileSync(path, "utf8"), origin: { kind: "file", path } }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OdwError("bad-args", `无法读取脚本 ${path}：${detail}`)
  }
}

/**
 * Runs the script with the host's own watchdog wrapping it.
 *
 * The sandbox timeout only covers synchronous execution, and an awaited host
 * promise is invisible to it, so the run is additionally raced against the wall
 * clock. If the race is lost, the run is reported as timed out even though the
 * abandoned script may still be parked - the controller abort is what makes the
 * abandoned part harmless.
 *
 * Both the timer *and* the abort signal must **resolve** the race, never cancel
 * it: the wall-clock abort is what stops a script parked on an `await` that can
 * never settle, so a listener that merely cleared the timer would swallow the
 * only event capable of ending the run and deadlock it permanently (measured:
 * `async (ctx) => { await new Promise(() => {}) }` never returned a result).
 */
async function runScriptWithWallClock(
  source: string,
  runContext: RunContext,
  options: ScriptRunOptions,
): Promise<ScriptResult> {
  const host = createScriptHost()
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<ScriptResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        status: "error",
        error: { kind: "timeout", message: `workflow 超过 ${options.timeoutMs}ms，已放弃等待（脚本被中止）` },
        elapsedMs: options.timeoutMs,
      })
    }, options.timeoutMs)
    onAbort = () => {
      resolve({
        status: "error",
        error: { kind: "aborted", message: "workflow 已被取消" },
        elapsedMs: Date.now() - startedAt,
      })
    }
    options.signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([host.run(source, runContext, options), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) options.signal.removeEventListener("abort", onAbort)
  }
}

type ProgressChannel = {
  emit(update: Record<string, unknown>, force: boolean): void
  drain(): Promise<void>
}

/**
 * Progress is written to two places with different guarantees:
 *  - `progress()` is a live channel (TUI metadata) and is throttled to one write
 *    per `progressIntervalMs`, because a 50-worker fan-out would otherwise spam it;
 *  - the journal and synthetic messages are never throttled, because they are the
 *    durable record.
 *
 * Throttling always keeps the *latest* update pending, so the final state is never
 * the one that got dropped.
 */
function createProgressChannel(deps: RunWorkflowDeps): ProgressChannel {
  const sink = deps.progress
  let chain: Promise<void> = Promise.resolve()
  let lastAt = 0
  let pending: Record<string, unknown> | null = null

  const flush = (): void => {
    if (pending === null) return
    const update = pending
    pending = null
    lastAt = Date.now()
    if (sink === undefined) return
    chain = chain.then(() => Promise.resolve(sink(update)).catch(() => undefined))
  }

  return {
    emit(update: Record<string, unknown>, force: boolean): void {
      pending = update
      if (!force && Date.now() - lastAt < DEFAULTS.progressIntervalMs) return
      flush()
    },
    async drain(): Promise<void> {
      flush()
      await chain
    },
  }
}

function handleWorkerEvent(
  event: WorkerEvent,
  record: (outcome: WorkerOutcome) => void,
  progress: ProgressChannel,
): void {
  if (event.type === "start") {
    progress.emit(
      {
        phase: "worker:start",
        label: event.label,
        index: event.index,
        workerSessionID: event.sessionID,
        live: event.live,
        queued: event.queued,
        agent: event.agent,
        model: event.model,
        permissions: event.permissions,
      },
      false,
    )
    return
  }
  record(event.outcome)
  progress.emit(
    {
      phase: event.outcome.ok ? "worker:done" : "worker:failed",
      label: event.outcome.label,
      index: event.outcome.index,
      live: event.live,
      queued: event.queued,
      ok: event.outcome.ok,
      elapsedMs: event.outcome.elapsedMs,
      tokens: event.outcome.usage.tokens,
      cost: event.outcome.usage.cost,
      failure: event.outcome.failure ?? null,
    },
    false,
  )
}

type Inventory = {
  defaults: { model: ModelRef | null; agent: string | null }
  knownAgents: ReadonlySet<string> | null
  knownModels: ReadonlySet<string> | null
}

export type { Inventory }

/**
 * Reads session defaults plus the agent/model inventories. Exported because
 * `odw_plan` must validate against the *same* inventory the run will use -
 * a second implementation would drift.
 */
export async function loadInventory(deps: RunWorkflowDeps): Promise<Inventory> {
  let model: ModelRef | null = null
  let agent: string | null = null
  try {
    const info = structurally(await deps.ctx.session.get({ sessionID: deps.sessionID }))
    const inherited = structurally(info["model"])
    if (typeof inherited["providerID"] === "string" && typeof inherited["id"] === "string") {
      model = {
        providerID: inherited["providerID"],
        id: inherited["id"],
        variant: typeof inherited["variant"] === "string" ? inherited["variant"] : "default",
      }
    }
    if (typeof info["agent"] === "string") agent = info["agent"]
  } catch {
    // Not fatal: workers then inherit whatever the session defaults are.
  }

  let knownAgents: ReadonlySet<string> | null = null
  try {
    const items = unwrapList(await deps.ctx.agent.list())
    if (items.length > 0) {
      knownAgents = new Set(
        items.map((item) => structurally(item)["id"]).filter((id): id is string => typeof id === "string"),
      )
    }
  } catch {
    // ignore
  }

  let knownModels: ReadonlySet<string> | null = null
  try {
    const items = unwrapList(await deps.ctx.model.list())
    if (items.length > 0) {
      const ids = items
        .map((item) => {
          const entry = structurally(item)
          const providerID = entry["providerID"]
          const id = entry["id"]
          return typeof providerID === "string" && typeof id === "string" ? `${providerID}/${id}` : null
        })
        .filter((id): id is string => id !== null)
      if (ids.length > 0) knownModels = new Set(ids)
    }
  } catch {
    // ignore
  }

  return { defaults: { model, agent }, knownAgents, knownModels }
}

/** `ctx.model.list()` / `ctx.agent.list()` return `{data, location}`, not arrays (PLAN §1 C12). */
function unwrapList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const boxed = structurally(value)
  for (const key of ["data", "items", "models", "agents", "entries"]) {
    const candidate = boxed[key]
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function structurally(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function resolveRunId(input: string | undefined): string {
  const provided = typeof input === "string" ? input.trim() : ""
  if (provided !== "") {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provided)) {
      throw new OdwError("bad-args", `runId 只允许 [A-Za-z0-9._-]，长度 1..64（收到 ${JSON.stringify(input)}）`)
    }
    return provided
  }
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("")
  const random = Math.random().toString(36).slice(2, 6)
  return `run-${stamp}-${random}`
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/**
 * Turns a script-authored checkpoint label into a file-name fragment. Everything
 * outside `[A-Za-z0-9._-]` collapses to `_`, so `"../../etc/passwd"` becomes
 * `.._.._etc_passwd` and cannot leave the run directory.
 */
function sanitizeLabel(label: string): string {
  const cleaned = label.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "")
  return (cleaned === "" ? "checkpoint" : cleaned).slice(0, 64)
}

/* ------------------------------------------------------------------ *
 * Human-facing summaries
 * ------------------------------------------------------------------ */

type SummaryStats = {
  started: number
  failed: number
  elapsedMs: number
  cost: number
  artifactsDir: string
  tokens?: number
}

function summarizeOk(runId: string, returnValue: unknown, stats: SummaryStats): string {
  const lines = [
    `ODW run ${runId} 完成 ✅`,
    `- workers: 启动 ${stats.started}，失败 ${stats.failed}`,
    `- 耗时: ${(stats.elapsedMs / 1000).toFixed(1)}s，花费: $${stats.cost.toFixed(4)}（${(stats.tokens ?? 0).toLocaleString()} tok）`,
    `- 现场: ${stats.artifactsDir}`,
  ]
  const rendered = truncateValue(returnValue)
  if (rendered !== undefined) {
    lines.push("- 脚本返回值:", "```", typeof rendered === "string" ? rendered : JSON.stringify(rendered, null, 2), "```")
  }
  return cap(lines.join("\n"))
}

function summarizeError(runId: string, error: ScriptError, stats: SummaryStats): string {
  const lines = [
    `ODW run ${runId} 失败 ❌`,
    `- 错误类型: ${error.kind}`,
    `- 错误信息: ${error.message}`,
    `- 已启动 workers: ${stats.started}（失败 ${stats.failed}）`,
    `- 耗时: ${(stats.elapsedMs / 1000).toFixed(1)}s，花费: $${stats.cost.toFixed(4)}`,
    `- 现场: ${stats.artifactsDir}`,
  ]
  return cap(lines.join("\n"))
}

function truncateValue(value: unknown, limit = 2_000): unknown {
  if (value === undefined) return undefined
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value
  try {
    const json = JSON.stringify(value, null, 2)
    if (json === undefined) return String(value)
    return json.length > limit ? `${json.slice(0, limit)}…（已截断）` : value
  } catch {
    return String(value)
  }
}

function cap(text: string, limit = 6_000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
}
