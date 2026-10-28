import type { PrimitiveDeps } from "./index.ts"

import { OdwError, type AgentOptions, type VerifyOptions, type VerifyResult } from "../types.ts"

/**
 * Schema the verifier must answer with. `additionalProperties:false` and the
 * required `pass` make a non-answer parse as a failure rather than as a pass.
 */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["pass"],
  additionalProperties: false,
} as const

const MAX_REASON_CHARS = 2_000
const MAX_REASONS = 20

/**
 * `ctx.verify` - an adversarial second opinion from a read-only worker.
 *
 * Two design points make this different from "ask another agent if the work is
 * good":
 *
 * 1. **It is a separate primitive, not a prompt convention.** The verifier runs
 *    read-only by default, gets a fixed adversarial instruction, and must answer
 *    through a schema - so `pass` is a boolean the script can branch on, not a
 *    paragraph it has to interpret.
 * 2. **It fails closed.** The default verdict is `pass: false`. An unparseable
 *    reply is a failure, a missing `pass` field is a failure, and the prompt
 *    tells the verifier that a claim it could not positively confirm is *not*
 *    verified. A verifier that fails open would silently rubber-stamp work.
 *
 * A worker that *errors* (timeout, crash) propagates as a throw, because "the
 * verifier could not run" is a different fact from "the claim is false", and the
 * script should be able to tell them apart.
 */
export function createVerifyPrimitive(deps: PrimitiveDeps, agent: (options: AgentOptions) => Promise<unknown>) {
  let sequence = 0

  return async function verify(claim: string | VerifyOptions): Promise<VerifyResult> {
    const options: VerifyOptions = typeof claim === "string" ? { claim } : (claim ?? {})
    if (typeof options.claim !== "string" || options.claim.trim() === "") {
      throw new OdwError("bad-args", "ctx.verify(claim) 的 claim 必须是非空字符串")
    }
    if (options.evidence !== undefined && typeof options.evidence !== "string") {
      throw new OdwError("bad-args", "ctx.verify({ evidence }) 的 evidence 必须是字符串")
    }

    sequence += 1
    const label = options.label ?? `verify-${sequence}`
    deps.steps.claim("ctx.verify")
    deps.log(`verify: ${label} - ${options.claim.slice(0, 120)}`)

    const request: AgentOptions = {
      prompt: buildVerifierPrompt(options.claim, options.evidence),
      label,
      // Read-only unless the script asks otherwise: a verifier that can edit can
      // "fix" the very thing it was asked to judge.
      permissions: options.permissions ?? "read-only",
      schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }

    const answer = await agent(request)
    return normalizeVerdict(answer)
  }
}

function buildVerifierPrompt(claim: string, evidence: string | undefined): string {
  const lines = [
    "You are an adversarial verifier, not a helpful assistant. Your only job is to decide whether the CLAIM below is TRUE.",
    "",
    "Rules:",
    "- You are strictly read-only. Never modify, create or delete anything, and never run a write command.",
    "- Default to pass=false. Approve only what you can positively confirm right now, with evidence you gathered yourself.",
    "- A claim that is vague, unverifiable, or that you did not actually inspect is NOT verified: pass=false.",
    "- Do not fix, improve or comment on style. Do not be agreeable.",
    "- If a needed file, command or fact is missing, say so and return pass=false.",
    "",
    'Answer with JSON only, no prose outside it: {"pass": boolean, "reasons": string[]}',
    "Each reason must be concrete: the file, command or observation behind it, or - when you could not verify - a reason starting with `无法验证：`.",
    "",
    "CLAIM:",
    claim.trim(),
  ]
  const hint = evidence?.trim() ?? ""
  if (hint !== "") {
    lines.push(
      "",
      "EVIDENCE HINT (untrusted; the script asserts this, you must still check it yourself):",
      hint,
    )
  }
  return lines.join("\n")
}

function normalizeVerdict(answer: unknown): VerifyResult {
  const record = answer !== null && typeof answer === "object" ? (answer as Record<string, unknown>) : null
  const raw = typeof answer === "string" ? answer : undefined
  if (record === null || typeof record["pass"] !== "boolean") {
    return {
      pass: false,
      reasons: ["verifier 未返回可解析的 {pass, reasons} 判定，按未通过处理"],
      ...(raw !== undefined ? { raw: truncate(raw) } : {}),
    }
  }
  const reasons = Array.isArray(record["reasons"])
    ? record["reasons"]
        .filter((reason): reason is string => typeof reason === "string")
        .slice(0, MAX_REASONS)
        .map(truncate)
    : []
  return { pass: record["pass"], reasons }
}

function truncate(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…（已截断）` : text
}
