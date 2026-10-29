import { describe, expect, it } from "vitest"

import { Steps } from "../../src/runner/steps.ts"
import { StepLimitError } from "../../src/types.ts"

describe("Steps", () => {
  it("counts every claim and reports used/limit", () => {
    const steps = new Steps(3)
    expect(steps.count).toBe(0)
    steps.claim("a")
    steps.claim("b")
    expect(steps.count).toBe(2)
    expect(steps.limit).toBe(3)
  })

  it("allows exactly `max` calls and throws on the next one", () => {
    const steps = new Steps(2)
    steps.claim("a")
    steps.claim("b")
    expect(() => steps.claim("c")).toThrow(StepLimitError)
  })

  it("classifies the failure as step-limit and names the step that broke it", () => {
    const steps = new Steps(1)
    steps.claim("ok")
    let caught: unknown
    try {
      steps.claim("ctx.parallel")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StepLimitError)
    expect((caught as StepLimitError).kind).toBe("step-limit")
    expect((caught as StepLimitError).message).toContain("ctx.parallel")
    expect((caught as StepLimitError).message).toContain("step 2")
  })
})
