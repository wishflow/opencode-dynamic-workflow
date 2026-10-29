import type { Plugin } from "@opencode/plugin"

import { ODW_PLAN_DOC, ODW_RUN_DOC } from "../script/api-doc.ts"
import { planWorkflow } from "../script/plan.ts"
import { runWorkflow, type RunWorkflowInput } from "../runner/runner.ts"
import { OdwError } from "../types.ts"

/**
 * The model-facing tool surface.
 *
 * Three tools: `odw_ping` (liveness), `odw_plan` (free dry run) and `odw_run`
 * (execution). Everything a workflow can do is inside the script, not in extra
 * tools - a growing tool list would be a second, weaker scripting language.
 */
export async function registerTools(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const registration = await ctx.tool.transform((editor) => {
    editor.add({
      name: "ping",
      description:
        "opencode-dynamic-workflow liveness probe. Returns the plugin's runtime binding to the host opencode server. Call it when verifying that the odw plugin is loaded and able to execute tools.",
      options: { namespace: "odw", codemode: true },
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => ({
        content: JSON.stringify({
          ok: true,
          pluginId: "odw",
          opencode: ctx.app.version,
          channel: ctx.app.channel,
          directory: ctx.location.directory,
          projectId: ctx.location.project.id,
        }),
      }),
    })

    editor.add({
      name: "plan",
      description: ODW_PLAN_DOC,
      options: { namespace: "odw", codemode: true },
      input: RUN_INPUT_SCHEMA,
      execute: async (input: unknown, context) => {
        const result = await planWorkflow(
          { ctx, sessionID: context.sessionID, directory: ctx.location.directory },
          parseRunInput(input),
        )
        return { content: result.humanSummary, metadata: result.metadata }
      },
    })

    editor.add({
      name: "run",
      description: ODW_RUN_DOC,
      options: { namespace: "odw", codemode: true },
      input: RUN_INPUT_SCHEMA,
      execute: async (input: unknown, context) => {
        const result = await runWorkflow(
          {
            ctx,
            sessionID: context.sessionID,
            directory: ctx.location.directory,
            signal: context.signal,
            progress: context.progress,
          },
          parseRunInput(input),
        )
        return { content: result.humanSummary, metadata: result.metadata }
      },
    })
  })

  return () => registration.dispose()
}

/**
 * `odw_plan` and `odw_run` take the same input on purpose: a plan that validated
 * a different call than the one that runs would be worse than no plan.
 */
const RUN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    script: {
      type: "string",
      description:
        "Inline workflow source: an expression evaluating to `async (ctx) => {...}`. Preferred while iterating.",
    },
    file: {
      type: "string",
      description: "Path to a workflow script. Relative paths resolve inside `<project>/workflows/`.",
    },
    runId: { type: "string", description: "Optional run id ([A-Za-z0-9._-], 1..64)." },
    concurrency: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Max worker sessions in flight. Default 4.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1000,
      description: "Wall-clock budget for the whole script. Default 600000.",
    },
    budgetUsd: { type: "number", description: "Stop starting new workers once spend exceeds this." },
    maxWorkers: { type: "integer", minimum: 1, description: "Hard cap on worker sessions. Default 50." },
  },
  additionalProperties: false,
} as const

/**
 * Tool input is untrusted JSON: the JSON Schema above is declarative metadata, not
 * enforcement, and `exactOptionalPropertyTypes` forbids letting `undefined`
 * through. Validating here means a bad value produces one readable ODW error
 * instead of a strange failure deep inside the runner.
 */
export function parseRunInput(input: unknown): RunWorkflowInput {
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const out: RunWorkflowInput = {}

  const script = optionalString(record["script"], "script")
  if (script !== undefined) out.script = script
  const file = optionalString(record["file"], "file")
  if (file !== undefined) out.file = file
  if (script === undefined && file === undefined) {
    throw new OdwError("bad-args", "provide either script (inline source) or file (a path under workflows/)")
  }

  const runId = optionalString(record["runId"], "runId")
  if (runId !== undefined) out.runId = runId

  const concurrency = optionalInt(record["concurrency"], "concurrency", 1, 10)
  if (concurrency !== undefined) out.concurrency = concurrency

  const timeoutMs = optionalInt(record["timeoutMs"], "timeoutMs", 1_000, 24 * 60 * 60 * 1000)
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs

  const maxWorkers = optionalInt(record["maxWorkers"], "maxWorkers", 1, 10_000)
  if (maxWorkers !== undefined) out.maxWorkers = maxWorkers

  const budgetUsd = optionalNumber(record["budgetUsd"], "budgetUsd")
  if (budgetUsd !== undefined) out.budgetUsd = budgetUsd

  return out
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new OdwError("bad-args", `${name} must be a string`)
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function optionalInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OdwError("bad-args", `${name} must be a number`)
  const int = Math.floor(value)
  if (int < min || int > max) throw new OdwError("bad-args", `${name} must be between ${min} and ${max} (got ${value})`)
  return int
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new OdwError("bad-args", `${name} must be a positive number`)
  }
  return value
}
