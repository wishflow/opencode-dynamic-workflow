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

export function resolvePermissions(spec: PermissionSpec | undefined): readonly PermissionRule[] | undefined {
  if (spec === undefined || spec === "inherit") return undefined
  if (spec === "read-only") return READ_ONLY_RULES
  if (spec === "dangerous-full-access") return FULL_ACCESS_RULES
  if (Array.isArray(spec)) {
    return spec.length === 0 ? undefined : (spec as readonly PermissionRule[])
  }
  throw new TypeError(`未知的 permissions：${JSON.stringify(spec)}`)
}

export function describePermissions(spec: PermissionSpec | undefined): PermissionMode | "custom" {
  if (spec === undefined) return "inherit"
  if (typeof spec === "string") return spec
  return "custom"
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
