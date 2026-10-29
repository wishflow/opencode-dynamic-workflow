import vm from "node:vm"

import type { Plugin } from "@opencode/plugin"

import { loadInventory, resolveScriptSource, DEFAULTS, type RunWorkflowInput } from "../runner/runner.ts"
import { asCallableExpression, normalizeScript } from "./normalize.ts"

/**
 * `odw_plan` - a dry run that spends nothing.
 *
 * It exists because a workflow script is written blind: the model cannot run it
 * in its head, and the first real run is the first time anyone learns that
 * `agent: "explore "` has a trailing space, or that `mode: "oneshot"` is not
 * implemented. Every one of those mistakes costs a full run (workers, wallet,
 * wall clock) to discover. This validates the cheap, decidable half of the
 * question and says plainly what it could not decide.
 *
 * Two honest limits, stated in the output rather than hidden:
 *
 *  - it **compiles** the script but never evaluates or invokes it, so the check
 *    is syntax plus a static scan, not a simulation. Explaining *why* it cannot
 *    simulate: evaluating `(<source>)` would run any IIFE in it, and invoking the
 *    body would dispatch real workers. So the dry run stays a read.
 *  - the scan only reads **string literals** in `ctx.agent({...})` /
 *    `ctx.verify({...})` call sites. `agent: someVar` and calls built inside
 *    `parallel`/`loop` are reported as `dynamic`, never guessed at.
 */

export type PlanDeps = {
  readonly ctx: Plugin.Context
  readonly sessionID: string
  readonly directory: string
}

export type PlanResult = {
  readonly ok: boolean
  readonly humanSummary: string
  readonly metadata: Record<string, unknown>
}

const KNOWN_PERMISSIONS = new Set(["inherit", "read-only", "dangerous-full-access"])
const KNOWN_MODES = new Set(["agentic", "oneshot"])

export async function planWorkflow(deps: PlanDeps, input: RunWorkflowInput): Promise<PlanResult> {
  const problems: string[] = []
  const warnings: string[] = []

  // Same resolution the run would use, so the dry run can never validate a
  // different script than the one that executes.
  const resolved = resolveScriptSource(input, deps.directory)
  const source = resolved.source

  let compiled = false
  let syntaxError: string | null = null
  try {
    const normalized = normalizeScript(source)
    // Compile only. `new vm.Script` parses without running, which is exactly the
    // boundary this tool promises.
    new vm.Script(asCallableExpression(normalized), { filename: "odw-plan/workflow.ts" })
    compiled = true
  } catch (error) {
    syntaxError = error instanceof Error ? error.message : String(error)
    problems.push(`script does not compile: ${syntaxError}`)
  }

  const callsites = scanWorkerCalls(source)

  const inventory = await loadInventory({ ctx: deps.ctx, sessionID: deps.sessionID, directory: deps.directory, signal: new AbortController().signal })

  for (const site of callsites) {
    const where = `line ${site.line} ${site.primitive}`
    // Literal fields are validated even when the site is `dynamic`: a literal
    // `agent: "explor"` next to a dynamic `evidence` expression is still a typo
    // worth catching, and skipping it would be a false pass.
    if (site.agent !== undefined) {
      if (inventory.knownAgents !== null && !inventory.knownAgents.has(site.agent)) {
        problems.push(`${where}: unknown agent ${JSON.stringify(site.agent)} (available: ${[...inventory.knownAgents].join(", ")})`)
      }
    }
    if (site.model !== undefined && inventory.knownModels !== null) {
      const bare = site.model.split("#")[0] ?? site.model
      if (!inventory.knownModels.has(bare)) {
        problems.push(`${where}: unknown model ${JSON.stringify(site.model)} (expected "provider/model"; ${inventory.knownModels.size} available)`)
      }
    }
    if (site.permissions !== undefined && !KNOWN_PERMISSIONS.has(site.permissions)) {
      problems.push(`${where}: unknown permissions ${JSON.stringify(site.permissions)} (available: inherit, read-only, dangerous-full-access)`)
    }
    if (site.mode !== undefined) {
      if (!KNOWN_MODES.has(site.mode)) {
        problems.push(`${where}: unknown mode ${JSON.stringify(site.mode)} (available: agentic, oneshot)`)
      } else if (site.mode === "oneshot") {
        warnings.push(
          `${where}: mode "oneshot" denies the worker **every** tool (including reading files): its answer can only come from the prompt,` +
            `so do not ask it to look at the codebase`,
        )
      }
    }
    if (site.effort !== undefined && site.model !== undefined) {
      problems.push(
        `${where}: both model and effort were given: effort is just the model's #variant and two sources of truth disagree, so pass only one`,
      )
    }
    if (site.effort !== undefined || site.model !== undefined) {
      // The variant lives either in the model ref (`p/m#high`) or in `effort`.
      const explicit = site.model !== undefined ? parseModelKey(site.model) : null
      const key = explicit?.key ?? defaultModelKey(inventory.defaults.model)
      const variant = site.effort ?? explicit?.variant ?? null
      if (variant !== null && key !== null) {
        const allowed = inventory.modelVariants?.get(key)
        if (allowed !== undefined && allowed.size > 0 && !allowed.has(variant)) {
          problems.push(
            `${where}: unknown variant ${JSON.stringify(variant)} (model ${key}). Available: ${[...allowed].sort().join(", ")}`,
          )
        }
      }
      if (variant !== null && key !== null && inventory.modelVariants?.get(key) === undefined) {
        warnings.push(`${where}: the host did not report a variant list for model ${key}, so ${JSON.stringify(variant)} cannot be checked at plan time`)
      }
    }
    if (site.dynamic) {
      warnings.push(
        `${where}: some arguments are not literals (dynamic), so only the literal fields above could be checked; dynamic values in agent/model/mode/permissions are not checked here`,
      )
    }
    if (site.primitive === "ctx.verify" && site.permissions === undefined) {
      warnings.push(`${where}: no permissions given; verify defaults to read-only (as expected)`)
    }
  }

  const literalSites = callsites.filter((site) => !site.dynamic).length
  const dynamicSites = callsites.length - literalSites
  if (dynamicSites > 0) {
    warnings.push(
      `${dynamicSites} worker call site(s) have dynamic arguments: the real worker count is decided at runtime,` +
        `so only maxWorkers/concurrency/budgetUsd can cap it and it cannot be estimated at plan time`,
    )
  }
  if (callsites.length === 0 && compiled) {
    warnings.push("no textual ctx.agent / ctx.verify call found in the script: this run may start no worker at all (it costs nothing, and may do nothing)")
  }
  if (/ctx\.agent|ctx\.verify/.test(source) && callsites.length === 0) {
    warnings.push("the source mentions ctx.agent/ctx.verify but no call site could be parsed: it may sit inside a string or template, or be written in a way the static scan does not support")
  }

  const concurrency = clampInt(input.concurrency ?? DEFAULTS.concurrency, 1, DEFAULTS.maxConcurrency)
  const timeoutMs = clampInt(input.timeoutMs ?? DEFAULTS.timeoutMs, 1_000, 24 * 60 * 60 * 1000)
  const maxWorkers = clampInt(input.maxWorkers ?? DEFAULTS.maxWorkers, 1, 10_000)
  if (input.budgetUsd !== undefined && input.budgetUsd <= 0) {
    problems.push(`budgetUsd must be greater than 0 (got ${input.budgetUsd})`)
  }

  const ok = problems.length === 0
  const metadata: Record<string, unknown> = {
    ok,
    dryRun: true,
    executed: false,
    origin: resolved.origin,
    scriptChars: source.length,
    compiled,
    syntaxError,
    params: {
      runId: input.runId ?? "(auto)",
      concurrency,
      timeoutMs,
      maxWorkers,
      maxSteps: DEFAULTS.maxSteps,
      budgetUsd: input.budgetUsd ?? null,
    },
    defaults: inventory.defaults,
    inventory: {
      agents: inventory.knownAgents === null ? null : [...inventory.knownAgents].sort(),
      models: inventory.knownModels === null ? null : inventory.knownModels.size,
    },
    workerCallsites: callsites.map((site) => ({
      line: site.line,
      primitive: site.primitive,
      dynamic: site.dynamic,
      agent: site.agent ?? null,
      model: site.model ?? null,
      effort: site.effort ?? null,
      mode: site.mode ?? null,
      permissions: site.permissions ?? null,
    })),
    literalCallsites: literalSites,
    dynamicCallsites: dynamicSites,
    modelVariants: inventory.modelVariants === null ? null : Object.fromEntries(
      [...inventory.modelVariants].map(([key, value]) => [key, [...value].sort()]),
    ),
    problems,
    warnings,
  }

  return { ok, humanSummary: summarize(metadata, problems, warnings), metadata }
}

/** Splits `"provider/model#variant"` into its key and variant. */
function parseModelKey(model: string): { key: string; variant: string | null } {
  const [key, variant] = model.split("#")
  return { key: (key ?? model).trim(), variant: variant === undefined ? null : variant.trim() }
}

function defaultModelKey(model: { providerID: string; id: string } | null): string | null {
  return model === null ? null : `${model.providerID}/${model.id}`
}

/* ------------------------------------------------------------------ *
 * Static scan
 * ------------------------------------------------------------------ */

type WorkerCallSite = {
  line: number
  primitive: "ctx.agent" | "ctx.verify"
  dynamic: boolean
  agent?: string
  model?: string
  effort?: string
  mode?: string
  permissions?: string
}

export type { WorkerCallSite }

/**
 * Finds `ctx.agent(...)` / `ctx.verify(...)` at code positions and reads the
 * literal string fields of their options object.
 *
 * The lexer exists so a `ctx.agent` inside a string or a comment is not counted
 * as a call. Template literals are treated as code (a deliberate simplification:
 * over-detecting costs an extra `dynamic` note, under-detecting would silently
 * skip a real call site).
 *
 * Exported for the unit tests: the scan is the part of `odw_plan` most likely to
 * be quietly wrong, and its failure mode is a *false pass* (a typo the planner
 * says is fine).
 */
export function scanWorkerCalls(source: string): WorkerCallSite[] {
  const mask = codeMask(source)
  const sites: WorkerCallSite[] = []
  const pattern = /\bctx\s*\.\s*(agent|verify)\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    if (mask[match.index] !== 1) continue
    const primitive = match[1] === "agent" ? "ctx.agent" : "ctx.verify"
    let cursor = pattern.lastIndex
    while (cursor < source.length && /\s/.test(source[cursor] ?? "")) cursor += 1
    if (source[cursor] !== "(") continue
    const args = readBalanced(source, mask, cursor, "(", ")")
    if (args === null) continue
    const line = lineAt(source, match.index)
    const fields = readTopLevelStringFields(args.text, args.codeMask, args.offset)
    sites.push({
      line,
      primitive,
      dynamic: fields.dynamic,
      ...(fields.values["agent"] !== undefined ? { agent: fields.values["agent"] } : {}),
      ...(fields.values["model"] !== undefined ? { model: fields.values["model"] } : {}),
      ...(fields.values["effort"] !== undefined ? { effort: fields.values["effort"] } : {}),
      ...(fields.values["mode"] !== undefined ? { mode: fields.values["mode"] } : {}),
      ...(fields.values["permissions"] !== undefined ? { permissions: fields.values["permissions"] } : {}),
    })
    pattern.lastIndex = args.end
  }
  return sites
}

/** 1 = code, 0 = inside a line comment, block comment, or a '...'/"..." string. */
function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length).fill(1)
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === "/" && source[i + 1] === "/") {
      const start = i
      while (i < source.length && source[i] !== "\n") i += 1
      mask.fill(0, start, i)
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = i
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1
      i = Math.min(source.length, i + 2)
      mask.fill(0, start, i)
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      const start = i
      i += 1
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      mask.fill(0, start, i)
      continue
    }
    i += 1
  }
  return mask
}

type Balanced = { text: string; codeMask: Uint8Array; offset: number; end: number }

function readBalanced(source: string, mask: Uint8Array, openIndex: number, open: string, close: string): Balanced | null {
  let depth = 0
  let i = openIndex
  while (i < source.length) {
    const c = source[i]
    if (mask[i] === 1) {
      if (c === open) depth += 1
      else if (c === close) {
        depth -= 1
        if (depth === 0) {
          const start = openIndex + 1
          return {
            text: source.slice(start, i),
            codeMask: mask.slice(start, i),
            offset: start,
            end: i + 1,
          }
        }
      }
    }
    i += 1
  }
  return null
}

type FieldScan = { values: Record<string, string>; dynamic: boolean }

/**
 * Reads the **depth-1** `key: "literal"` pairs of an options object.
 *
 * Depth-1 only, on purpose: a `schema` object nests arbitrary JSON, so scanning
 * every depth would pick up a nested `type: "object"` as if it were an option.
 *
 * Each value is consumed **as a whole** (see `skipValue`) rather than walked
 * character by character. That distinction matters: walking `label: "a" + item`
 * character-wise reaches the bare identifier `item`, mistakes it for a shorthand
 * property, and marks the whole call site `dynamic` - which used to make the
 * planner skip a literal `agent: "explor"` sitting in the same object. A false
 * pass is the one outcome this scan must not have.
 */
function readTopLevelStringFields(text: string, mask: Uint8Array, offset: number): FieldScan {
  void offset
  const values: Record<string, string> = {}
  let dynamic = false
  const first = skipWs(text, mask, 0)
  if (text[first] !== "{") return { values, dynamic: true }

  let i = first + 1 // past the opening brace
  while (i < text.length) {
    i = skipSeparators(text, mask, i)
    const c = text[i]
    if (c === undefined || c === "}") break

    if (c === "." && text[i + 1] === "." && text[i + 2] === ".") {
      // A spread: which fields exist is a runtime question.
      dynamic = true
      i = skipValue(text, mask, i)
      continue
    }

    const keyMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(text.slice(i))
    if (keyMatch === null) {
      // A shorthand property or a computed key.
      dynamic = true
      i = skipValue(text, mask, i)
      continue
    }

    const key = keyMatch[1] ?? ""
    const valueStart = skipWs(text, mask, i + keyMatch[0].length)
    const quote = text[valueStart]
    if (quote === '"' || quote === "'") {
      const read = readStringLiteral(text, mask, valueStart)
      if (read === null) {
        dynamic = true
        i = skipValue(text, mask, valueStart)
        continue
      }
      // `"read:" + item` is not the literal `"read:"`: the rest of the expression
      // is consumed as part of this value, and a *sensitive* key in that shape is
      // reported dynamic rather than validated against a prefix.
      const after = skipWs(text, mask, read.end)
      if (text[after] === "," || text[after] === "}") {
        values[key] = read.value
        i = read.end
        continue
      }
      if (SENSITIVE_FIELDS.has(key)) dynamic = true
      const next = skipValue(text, mask, read.end)
      if (text[next] !== "," && text[next] !== "}") dynamic = true
      i = next
      continue
    }

    if (SENSITIVE_FIELDS.has(key)) dynamic = true
    const next = skipValue(text, mask, valueStart)
    // If the value did not terminate at a `,` or `}`, the walk lost its place
    // (an exotic literal, say) and the remaining fields are unknown: better to
    // admit that than to silently stop validating.
    if (text[next] !== "," && text[next] !== "}") dynamic = true
    i = next
  }
  return { values, dynamic }
}

const SENSITIVE_FIELDS = new Set(["agent", "model", "effort", "mode", "permissions"])

/** Skips whitespace and top-level commas between properties. */
function skipSeparators(text: string, mask: Uint8Array, from: number): number {
  let i = from
  while (i < text.length) {
    const c = text[i] ?? ""
    if (mask[i] !== 1) break
    if (/\s/.test(c) || c === ",") {
      i += 1
      continue
    }
    break
  }
  return i
}

/**
 * Returns the index just past one property value: stops at the `,` or `}` that is
 * at depth 0 relative to the value, skipping over nested brackets and strings.
 */
function skipValue(text: string, mask: Uint8Array, from: number): number {
  let depth = 0
  let i = from
  while (i < text.length) {
    if (mask[i] === 1) {
      const c = text[i] ?? ""
      if (c === "(" || c === "[" || c === "{") {
        depth += 1
      } else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return i
        depth -= 1
      } else if (c === "," && depth === 0) {
        return i
      }
    }
    i += 1
  }
  return i
}

function readStringLiteral(text: string, mask: Uint8Array, start: number): { value: string; end: number } | null {
  const quote = text[start]
  let i = start + 1
  let value = ""
  while (i < text.length) {
    const c = text[i] ?? ""
    if (mask[i] !== 1) {
      // Inside the literal, the mask is 0 - the characters are literal text.
      if (c === "\\") {
        const next = text[i + 1] ?? ""
        value += next === "n" ? "\n" : next
        i += 2
        continue
      }
      if (c === quote) return { value, end: i + 1 }
      if (c === "\n") return null
      value += c
      i += 1
      continue
    }
    if (c === "\\") {
      const next = text[i + 1] ?? ""
      value += next
      i += 2
      continue
    }
    if (c === quote) return { value, end: i + 1 }
    value += c
    i += 1
  }
  return null
}

function skipWs(text: string, mask: Uint8Array, from: number): number {
  let i = from
  while (i < text.length) {
    const c = text[i] ?? ""
    if (mask[i] === 1 && /\s/.test(c)) {
      i += 1
      continue
    }
    break
  }
  return i
}

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1
  }
  return line
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function summarize(metadata: Record<string, unknown>, problems: string[], warnings: string[]): string {
  const params = metadata["params"] as Record<string, unknown>
  const origin = metadata["origin"] as { kind: string; path?: string }
  const lines = [
    `ODW plan (dry run: nothing was executed, nothing was spent)${problems.length === 0 ? " ✅" : " ❌"}`,
    `- script: ${origin.kind === "file" ? origin.path : "inline"} (${metadata["scriptChars"]} chars)`,
    `- compiled: ${metadata["compiled"] === true ? "ok (compiled only, nothing was called)" : "failed"}`,
    `- params: concurrency=${params["concurrency"]}, timeoutMs=${params["timeoutMs"]}, maxWorkers=${params["maxWorkers"]}, maxSteps=${params["maxSteps"]}, budgetUsd=${String(params["budgetUsd"] ?? "unlimited")}`,
    `- statically visible worker call sites: ${metadata["literalCallsites"]} (dynamic: ${metadata["dynamicCallsites"]})`,
  ]
  const variantMap = metadata["modelVariants"] as Record<string, string[]> | null
  if (variantMap !== null) {
    const total = Object.keys(variantMap).length
    const sample = Object.entries(variantMap)
      .slice(0, 3)
      .map(([key, list]) => `${key}[${list.join(",")}]`)
      .join(" ")
    lines.push(`- variant lists: ${total} model(s) reported${sample === "" ? "" : ` (e.g. ${sample})`}`)
  } else {
    lines.push("- variant lists: none reported by the host (model #variant / effort cannot be checked at plan time)")
  }
  const sites = metadata["workerCallsites"] as Array<Record<string, unknown>>
  if (sites.length > 0) {
    lines.push("- call sites:")
    for (const site of sites) {
      const bits = [
        `line ${site["line"]}`,
        String(site["primitive"]),
        site["dynamic"] === true ? "dynamic args" : "",
        site["agent"] !== null && site["agent"] !== undefined ? `agent=${String(site["agent"])}` : "",
        site["model"] !== null && site["model"] !== undefined ? `model=${String(site["model"])}` : "",
        site["effort"] !== null && site["effort"] !== undefined ? `effort=${String(site["effort"])}` : "",
        site["mode"] !== null && site["mode"] !== undefined ? `mode=${String(site["mode"])}` : "",
        site["permissions"] !== null && site["permissions"] !== undefined
          ? `permissions=${String(site["permissions"])}`
          : "",
      ].filter((bit) => bit !== "")
      lines.push(`  - ${bits.join(" ")}`)
    }
  }
  if (problems.length > 0) {
    lines.push("", "## Problems to fix first")
    for (const problem of problems) lines.push(`- ${problem}`)
  }
  if (warnings.length > 0) {
    lines.push("", "## Notes (non-blocking)")
    for (const warning of warnings) lines.push(`- ${warning}`)
  }
  lines.push("", "A passing plan is not a passing run: the static scan reads only literals, so it cannot see dynamic branches or runtime failures.")
  return lines.join("\n")
}
