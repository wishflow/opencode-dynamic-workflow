import { describe, expect, it } from "vitest"

import { ODW_HINT_MARKER, applyIntentHint, detectWorkflowIntent } from "../../src/plugin/trigger.ts"

/**
 * The prompt hook is advisory (D6) and, per the measured contract, **not**
 * exactly-once - so idempotency is not a nicety here: a second delivery that
 * appended the hint again would duplicate it in the user's own message.
 */
describe("prompt intent hint", () => {
  it("appends the hint to a batch-shaped prompt and records the kind", () => {
    const event: { prompt: { text?: string }; metadata?: Record<string, unknown> } = {
      prompt: { text: "核查 12 个脚本" },
    }
    const result = applyIntentHint(event)
    expect(result.injected).toBe(true)
    expect(result.kind).toBe("zh-count")
    expect(event.prompt.text).toContain("核查 12 个脚本")
    expect(event.prompt.text).toContain(ODW_HINT_MARKER)
    expect(event.prompt.text).toContain("odw_plan")
    expect(event.metadata).toEqual({ odwIntent: { detected: true, kind: "zh-count" } })
  })

  it("is idempotent: a second delivery changes nothing at all", () => {
    const event: { prompt: { text?: string }; metadata?: Record<string, unknown> } = {
      prompt: { text: "read every file in src/" },
    }
    applyIntentHint(event)
    const afterFirst = { text: event.prompt.text, metadata: JSON.stringify(event.metadata) }

    const second = applyIntentHint(event)

    expect(second.injected).toBe(false)
    expect(event.prompt.text).toBe(afterFirst.text)
    expect(JSON.stringify(event.metadata)).toBe(afterFirst.metadata)
  })

  it("never rewrites the user's words - only appends", () => {
    const original = "并行对比 A 和 B"
    const event: { prompt: { text?: string } } = { prompt: { text: original } }
    applyIntentHint(event)
    expect(event.prompt.text?.startsWith(original)).toBe(true)
  })

  it("stays silent on ordinary prompts", () => {
    const event: { prompt: { text?: string }; metadata?: Record<string, unknown> } = {
      prompt: { text: "这个函数为什么返回 undefined？" },
    }
    expect(applyIntentHint(event).injected).toBe(false)
    expect(event.prompt.text).toBe("这个函数为什么返回 undefined？")
    expect(event.metadata).toBeUndefined()
  })

  it("treats an empty prompt as nothing to do", () => {
    expect(applyIntentHint({ prompt: { text: "   " } }).injected).toBe(false)
    expect(applyIntentHint({}).injected).toBe(false)
  })

  it("does not fire on a bare 'check'/'compare' with no object", () => {
    expect(detectWorkflowIntent("can you check this?")).toBeNull()
    expect(detectWorkflowIntent("compare these two approaches")).toBeNull()
  })

  it("fires on explicit fan-out phrasing in both languages", () => {
    expect(detectWorkflowIntent("run these in parallel")).toBe("explicit-parallel")
    expect(detectWorkflowIntent("summarise all files")).toBe("enumerate-all")
    expect(detectWorkflowIntent("逐个审查每个模块")).toBe("zh-batch")
  })
})
