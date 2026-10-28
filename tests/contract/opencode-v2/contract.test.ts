import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Contract tests drive a real `opencode run`, take about a minute, and spawn real
 * model calls. They are opt-in:
 *
 *   ODW_CONTRACT=1 npx vitest run tests/contract
 *
 * See ./CONTRACT.md for the isolation rules and the observed matrix.
 */
const enabled = process.env["ODW_CONTRACT"] === "1"

describe.skipIf(!enabled)("opencode v2 contract", () => {
  it(
    "probe observations satisfy C1-C15",
    () => {
      const output = execFileSync("node", [join(HERE, "run.mjs")], {
        encoding: "utf8",
        timeout: 900_000,
        env: process.env,
      })
      expect(output).not.toContain("FAIL")
      expect(output).toMatch(/39\/39 passed/)
    },
    900_000,
  )
})
