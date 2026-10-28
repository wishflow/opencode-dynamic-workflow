import { zeroTokens, type Tokens, type WorkerFailure, type WorkerOutcome, type WorkerUsage } from "../types.ts"
import { formatModelRef } from "../params/model.ts"

/**
 * Structural view of the session messages ODW reads back.
 *
 * Deliberately structural (all fields optional) rather than imported from
 * `@opencode/plugin`: this code runs against whatever the *installed* opencode
 * returns, which is a different version from the type package (PLAN §1, the
 * 2.1.0-vs-2.2.0 skew). A cast-based extractor would silently produce `undefined`
 * for a moved field; this one degrades one field at a time.
 */
export type MessageLike = {
  type?: string
  text?: string
  content?: ReadonlyArray<{ type?: string; text?: string }>
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  cost?: number
  finish?: string
  error?: { type?: string; message?: string }
  outcome?: string
  agent?: string
  model?: { providerID?: string; id?: string; variant?: string }
}

export type ExtractOptions = {
  index: number
  label: string
  sessionID: string
  elapsedMs: number
  /**
   * When true the worker was asked for JSON. A reply that cannot be parsed is a
   * failure rather than a text answer: silently returning prose where the script
   * destructures fields produces confusing downstream errors.
   */
  expectJson: boolean
}

export function extractWorkerOutcome(messages: readonly MessageLike[], options: ExtractOptions): WorkerOutcome {
  const assistants = messages.filter((m) => m.type === "assistant")
  const idle = messages.find((m) => m.type === "idle")
  const last = assistants[assistants.length - 1]
  const usage = summarizeUsage(assistants)
  const base = {
    index: options.index,
    label: options.label,
    sessionID: options.sessionID,
    usage,
    elapsedMs: options.elapsedMs,
  }

  if (assistants.length === 0) {
    return {
      ...base,
      ok: false,
      text: "",
      failure: failureFor(undefined, idle, "worker 没有产生任何 assistant 消息"),
    }
  }

  const text = assistantText(last)
  if (idle?.outcome === "interrupted") {
    return { ...base, ok: false, text, failure: { kind: "aborted", message: "worker 会话被中断" } }
  }
  if (last?.error) {
    return { ...base, ok: false, text, failure: failureFor(last.error, idle, "worker 回合以错误结束") }
  }
  if (idle?.outcome === "failed") {
    return { ...base, ok: false, text, failure: failureFor(idle.error, idle, "worker 回合失败") }
  }
  if (text.trim() === "") {
    return { ...base, ok: false, text, failure: { kind: "internal", message: "worker 回复为空文本" } }
  }

  if (!options.expectJson) {
    return { ...base, ok: true, text }
  }

  const parsed = parseJsonLoose(text)
  if (parsed === undefined) {
    return {
      ...base,
      ok: false,
      text,
      failure: { kind: "internal", message: `worker 回复不是可解析的 JSON：${text.slice(0, 200)}` },
    }
  }
  return { ...base, ok: true, text, json: parsed }
}

function failureFor(
  error: { type?: string; message?: string } | undefined,
  idle: MessageLike | undefined,
  fallback: string,
): WorkerFailure {
  const detail = error?.message ?? (idle?.error as { message?: string } | undefined)?.message
  const type = error?.type ?? (idle?.error as { type?: string } | undefined)?.type
  if (type === "provider.quota" || /quota|rate limit|usage limit/i.test(detail ?? "")) {
    return { kind: "internal", message: `provider 额度/限流：${detail ?? fallback}` }
  }
  return { kind: "internal", message: detail ? `${type ?? "error"}: ${detail}` : fallback }
}

function assistantText(message: MessageLike | undefined): string {
  if (!message || !Array.isArray(message.content)) return ""
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

function summarizeUsage(assistants: readonly MessageLike[]): WorkerUsage {
  let tokens: Tokens = zeroTokens()
  let cost = 0
  let model: WorkerUsage["model"]
  for (const message of assistants) {
    const t = message.tokens
    if (t) {
      tokens = {
        input: tokens.input + num(t.input),
        output: tokens.output + num(t.output),
        reasoning: tokens.reasoning + num(t.reasoning),
        cacheRead: tokens.cacheRead + num(t.cache?.read),
        cacheWrite: tokens.cacheWrite + num(t.cache?.write),
      }
    }
    cost += num(message.cost)
    const m = message.model
    if (m?.providerID && m.id) {
      model = { providerID: m.providerID, id: m.id, variant: m.variant ?? "default" }
    }
  }
  return model ? { tokens, cost, model } : { tokens, cost }
}

function num(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function describeUsage(usage: WorkerUsage): string {
  const total = usage.tokens.input + usage.tokens.output + usage.tokens.reasoning
  const model = usage.model ? ` ${formatModelRef(usage.model)}` : ""
  return `${total} tok / $${usage.cost.toFixed(4)}${model}`
}

/**
 * Workers are told to answer with bare JSON, but models wrap it in prose or a
 * fenced block anyway. Try strict JSON first, then the outermost object/array.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const candidates = [trimmed, fenced?.[1]?.trim(), sliceOutermost(trimmed)].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
  )
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try next candidate
    }
  }
  return undefined
}

function sliceOutermost(text: string): string | undefined {
  const firstBrace = text.indexOf("{")
  const firstBracket = text.indexOf("[")
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const openChar = text[start]
  const closeChar = openChar === "{" ? "}" : "]"
  const end = text.lastIndexOf(closeChar)
  if (end <= start) return undefined
  return text.slice(start, end + 1)
}
