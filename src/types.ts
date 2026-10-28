/**
 * Shared types for opencode-dynamic-workflow.
 *
 * Two audiences live in this file:
 *  - the *script API* (`RunContext` and friends) - the only surface the model is
 *    allowed to see, and the only thing `api-doc.ts` documents;
 *  - the *host internals* (`WorkerOutcome`, `RunRecord`, ...) - never visible to
 *    the sandbox.
 */

/** Token accounting, mirroring opencode's `TokenUsage.Info` but flattened. */
export type Tokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function zeroTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export type ModelRef = {
  providerID: string
  id: string
  variant: string
}

export type PermissionEffect = "allow" | "deny" | "ask"

export type PermissionRule = {
  action: string
  resource: string
  effect: PermissionEffect
}

/**
 * Permission posture for a worker session.
 *
 * `"read-only"` is the safe default ODW wants to offer for analysis workflows;
 * `"inherit"` means "do not pass `permissions` at all", so the session picks up
 * the project/agent defaults.
 */
export type PermissionMode = "inherit" | "read-only" | "dangerous-full-access"

export type PermissionSpec = PermissionMode | readonly PermissionRule[]

/* ------------------------------------------------------------------ *
 * Script API (visible inside the sandbox)
 * ------------------------------------------------------------------ */

export type AgentMode = "agentic" | "oneshot"

export type AgentOptions = {
  /** The instruction handed to the worker session. Required, non-empty. */
  prompt: string
  /** Human label used in progress messages, journals and worker session titles. */
  label?: string
  /** opencode agent id (e.g. `"explore"`, `"build"`). Defaults to the session's agent. */
  agent?: string
  /** `"provider/model"` or `"provider/model#variant"`. Defaults to the calling session's model. */
  model?: string
  /**
   * Reasoning effort, as sugar for the inherited model's `#variant`
   * (`effort: "high"` == `model: "<inherited>#high"`).
   *
   * Mutually exclusive with `model`: both would decide the same thing, and the
   * run journal would have to guess which one won.
   */
  effort?: string
  /**
   * `"agentic"` (default) gives the worker its normal tools, so it can read the
   * repo and act on it.
   *
   * `"oneshot"` denies **every** tool and says so in the prompt: the answer must
   * come from the prompt alone. It is a posture, not a host-enforced single turn
   * (`session.create` has no tool-disable flag), so a one-shot worker can still
   * attempt a tool call - it gets denied and answers without it.
   */
  mode?: AgentMode
  /** Permission posture for the worker session. Defaults to `"inherit"`. */
  permissions?: PermissionSpec
  /** JSON Schema for the expected answer. When set, the worker's text is parsed as JSON. */
  schema?: Record<string, unknown>
  /** Per-worker wall-clock budget in milliseconds. */
  timeoutMs?: number
}

export type ParallelOptions = {
  /** Maximum items processed at once. Clamped to the run's `concurrency`. */
  concurrency?: number
}

/**
 * One stage of a `ctx.pipeline`.
 *
 * `input` is the previous stage's value (the item itself for the first stage),
 * `item` is the original element and `index` its position - the item is passed
 * alongside the running value so a later stage can still frame itself ("review
 * this summary, of file Y") without the script threading context by hand.
 */
export type PipelineStage = (input: unknown, item: unknown, index: number) => unknown

export type LoopOptions<S = unknown> = {
  /** Hard iteration cap. Required: an uncapped loop is not expressible. */
  max: number
  body: (state: S, iteration: number) => S | Promise<S>
  /** Checked after each body run; returning true stops the loop. */
  until?: (state: S, iteration: number) => boolean
  /** Starting state. Defaults to `undefined`. */
  initial?: S
}

export type LoopState<S = unknown> = {
  iterations: number
  state: S
  stopped: "until" | "max"
}

export type VerifyOptions = {
  /** The claim to falsify. Required, non-empty. */
  claim: string
  /** Untrusted hint (paths, output) the verifier should still check itself. */
  evidence?: string
  label?: string
  agent?: string
  model?: string
  /** Sugar for the inherited model's `#variant`. Mutually exclusive with `model`. */
  effort?: string
  /** Defaults to `"read-only"`: a verifier that can edit is not a verifier. */
  permissions?: PermissionSpec
  timeoutMs?: number
}

export type VerifyResult = {
  pass: boolean
  reasons: string[]
  /** Verifier's raw reply, when it was not parseable as the verdict schema. */
  raw?: string
}

export type BudgetSnapshot = {
  workers: number
  cost: number
  tokens: Tokens
  limitUsd: number | null
}

/**
 * The `ctx` object handed to a workflow script. This is the *entire* API: the
 * sandbox exposes nothing else besides these functions and a `console` shim.
 */
export type RunContext = {
  agent<T = string>(options: AgentOptions): Promise<T>
  parallel<T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R> | R,
    options?: ParallelOptions,
  ): Promise<R[]>
  pipeline<T, R = unknown>(items: readonly T[], ...stages: readonly PipelineStage[]): Promise<R[]>
  loop<S = unknown>(options: LoopOptions<S>): Promise<LoopState<S>>
  verify(claim: string | VerifyOptions): Promise<VerifyResult>
  /** Persists a named marker (journal entry + `checkpoints/NNN-<label>.json`). */
  checkpoint(label: string, data?: unknown): Promise<void>
  /** Stops the run deliberately. Always throws. */
  abort(reason?: string): never
  log(...args: unknown[]): void
  phase(name: string): void
  budget(): BudgetSnapshot
}

/* ------------------------------------------------------------------ *
 * Script execution
 * ------------------------------------------------------------------ */

export type ScriptErrorKind =
  | "syntax"
  | "timeout"
  | "aborted"
  | "budget"
  | "worker-limit"
  | "step-limit"
  | "worker-failed"
  | "bad-args"
  | "not-implemented"
  | "internal"

export type ScriptError = {
  kind: ScriptErrorKind
  message: string
  /** Worker label / primitive name that failed, when known. */
  at?: string
}

export type ScriptResult =
  | { status: "ok"; returnValue: unknown; elapsedMs: number }
  | { status: "error"; error: ScriptError; elapsedMs: number }

/* ------------------------------------------------------------------ *
 * Workers
 * ------------------------------------------------------------------ */

export type WorkerUsage = {
  tokens: Tokens
  cost: number
  model?: ModelRef
}

export type WorkerFailure = {
  kind: ScriptErrorKind
  message: string
}

export type WorkerOutcome = {
  /** Stable per-run index, 1-based, in start order. */
  index: number
  label: string
  ok: boolean
  text: string
  /** Parsed JSON answer when `schema` was requested. */
  json?: unknown
  sessionID?: string
  usage: WorkerUsage
  failure?: WorkerFailure
  elapsedMs: number
}

/* ------------------------------------------------------------------ *
 * Errors (host side)
 * ------------------------------------------------------------------ */

export class OdwError extends Error {
  readonly kind: ScriptErrorKind

  constructor(kind: ScriptErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = new.target.name
  }
}

export class BudgetExceededError extends OdwError {
  constructor(message: string) {
    super("budget", message)
  }
}

export class WorkerLimitError extends OdwError {
  constructor(message: string) {
    super("worker-limit", message)
  }
}

export class StepLimitError extends OdwError {
  constructor(message: string) {
    super("step-limit", message)
  }
}

export class WorkflowTimeoutError extends OdwError {
  constructor(message: string) {
    super("timeout", message)
  }
}

export class WorkflowAbortedError extends OdwError {
  constructor(message: string) {
    super("aborted", message)
  }
}

export class WorkerFailedError extends OdwError {
  readonly outcome: WorkerOutcome

  constructor(outcome: WorkerOutcome) {
    super("worker-failed", `worker ${outcome.label} 失败（${outcome.failure?.kind ?? "unknown"}）：${outcome.failure?.message ?? ""}`)
    this.outcome = outcome
  }
}

/**
 * Thrown when a model call is attempted from plugin `setup`. Measured: doing so
 * wedges the host server (PLAN §3.7), so it is a hard programming error, not a
 * runtime condition to recover from.
 */
export class SetupModelCallError extends OdwError {
  constructor(message: string) {
    super("internal", message)
  }
}

export function toScriptError(error: unknown): ScriptError {
  if (error instanceof OdwError) {
    return { kind: error.kind, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: classifyUnknown(error), message }
}

function classifyUnknown(error: unknown): ScriptErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout/i.test(message)) return "timeout"
  if (error instanceof SyntaxError) return "syntax"
  if (/aborted|AbortError/i.test(message)) return "aborted"
  return "internal"
}
