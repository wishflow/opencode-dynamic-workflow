import { Model } from "@opencode/plugin"

import { OdwError, type ModelRef } from "../types.ts"

/**
 * `Model.Ref` is an effect Schema whose `parse` is synchronous and throws on bad
 * input (measured: CONTRACT.md §3.1). Everything ODW accepts from the model or from
 * tool input has to pass through here so the failure is a readable ODW error
 * instead of a bare effect ParseError.
 */
export function parseModelRef(input: string): ModelRef {
  const text = input.trim()
  if (text === "") {
    throw new OdwError("bad-args", "model must not be an empty string")
  }
  try {
    const parsed = Model.Ref.parse(text) as ModelRef
    return { providerID: parsed.providerID, id: parsed.id, variant: parsed.variant ?? "default" }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OdwError(
      "bad-args",
      `cannot parse model ${JSON.stringify(input)}: expected "provider/model" or "provider/model#variant" (${detail.slice(0, 200)})`,
    )
  }
}

export function formatModelRef(ref: ModelRef): string {
  return ref.variant && ref.variant !== "default" ? `${ref.providerID}/${ref.id}#${ref.variant}` : `${ref.providerID}/${ref.id}`
}
