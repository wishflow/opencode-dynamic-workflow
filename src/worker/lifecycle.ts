import type { PermissionMode, PermissionRule, PermissionSpec } from "../types.ts"

/**
 * Permission posture -> concrete rules.
 *
 * Measured (PLAN §1 C4/C10): `session.create` and `session.update` both accept
 * `permissions: [{ action, resource, effect }]` and `session.get` reads the same
 * rules back, so a posture is just a rule list.
 *
 * `"read-only"` denies the mutating capability classes by name. The wildcard form
 * `{action: "*", effect: "deny"}` is *not* used for read-only: it would also deny
 * the read tools a worker needs, producing a worker that cannot do anything and
 * an unhelpful failure.
 */
const MUTATING_ACTIONS = ["edit", "write", "patch", "shell", "bash", "task"] as const

export const READ_ONLY_RULES: readonly PermissionRule[] = MUTATING_ACTIONS.map((action) => ({
  action,
  resource: "*",
  effect: "deny" as const,
}))

export const FULL_ACCESS_RULES: readonly PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }]

/**
 * "You may converse, nothing else." Used by `mode: "oneshot"`.
 *
 * Unlike `READ_ONLY_RULES`, this denies the read tools too. It is what makes an
 * one-shot worker cheap: it cannot go exploring, so it answers from the prompt
 * alone.
 *
 * The honest caveat: opencode exposes no "disable tools" flag on `session.create`
 * (checked against the generated types), so a one-shot worker *can* still attempt
 * a tool call - it is denied, and the model has to answer without it. This is
 * therefore "a turn that cannot do anything but talk", not a host-enforced
 * single turn.
 */
export const DENY_ALL_RULES: readonly PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }]

/**
 * Worker posture. Defined here (not in `agentic.ts`) so the permission helpers can
 * name it without an import cycle.
 */
export type WorkerMode = "agentic" | "oneshot"

export function resolvePermissions(spec: PermissionSpec | undefined): readonly PermissionRule[] | undefined {
  if (spec === undefined || spec === "inherit") return undefined
  if (spec === "read-only") return READ_ONLY_RULES
  if (spec === "dangerous-full-access") return FULL_ACCESS_RULES
  if (Array.isArray(spec)) {
    return spec.length === 0 ? undefined : (spec as readonly PermissionRule[])
  }
  throw new TypeError(`未知的 permissions：${JSON.stringify(spec)}`)
}

/**
 * How a worker's permissions should read in progress output and the journal.
 *
 * A one-shot worker with no explicit `permissions` is *not* "inherit" - it gets
 * `DENY_ALL_RULES` - and reporting it as inherit would make the journal describe a
 * posture the session does not have.
 */
export function describePermissions(
  spec: PermissionSpec | undefined,
  mode: WorkerMode = "agentic",
): PermissionMode | "custom" | "deny-all" {
  if (spec !== undefined) return typeof spec === "string" ? spec : "custom"
  return mode === "oneshot" ? "deny-all" : "inherit"
}

/**
 * The prompt actually sent to a worker.
 *
 * When a `schema` is requested the instruction has to carry the schema: workers
 * are ordinary sessions and have no out-of-band knowledge of the caller's intent.
 * The exact-JSON wording matters - measured worker replies are otherwise prose
 * with a fenced block, which `parseJsonLoose` can rescue but not always.
 */
export function buildWorkerPrompt(prompt: string, schema: Record<string, unknown> | undefined): string {
  if (!schema) return prompt
  return [
    prompt,
    "",
    "---",
    "Respond with a single JSON value and nothing else: no prose, no markdown fence,",
    "no trailing commentary. It must validate against this JSON Schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n")
}

/**
 * The prompt for a one-shot worker. It says the quiet part out loud: there are no
 * tools, so anything the answer needs must already be in the prompt, and asking
 * for a file is a wasted turn.
 */
export function buildOneshotPrompt(prompt: string, schema: Record<string, unknown> | undefined): string {
  const lines = [
    "You have no tools available in this session: no file access, no shell, no network.",
    "Answer directly, in a single reply, using only what is written below.",
    "",
    prompt,
  ]
  if (schema) {
    lines.push(
      "",
      "---",
      "Respond with a single JSON value and nothing else: no prose, no markdown fence,",
      "no trailing commentary. It must validate against this JSON Schema:",
      JSON.stringify(schema, null, 2),
    )
  }
  return lines.join("\n")
}
