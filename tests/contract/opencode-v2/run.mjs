#!/usr/bin/env node
/**
 * Contract harness for opencode 2.1.0.
 *
 * Creates a throwaway git project whose only plugin is a one-line shim to probe.ts,
 * runs opencode for real, then asserts the raw observations the probe wrote.
 *
 * It never reads or writes the user's ~/.config/opencode. See CONTRACT.md.
 *
 *   node tests/contract/opencode-v2/run.mjs                  # run + assert
 *   node tests/contract/opencode-v2/run.mjs --keep           # run + assert, keep artifacts
 *   node tests/contract/opencode-v2/run.mjs --no-assert      # run only, print observations
 *   node tests/contract/opencode-v2/run.mjs --reuse <dir>    # assert against a previous run
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { assertContract, loadObservations, report } from "./assert.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = join(HERE, "probe.ts")

const argv = process.argv.slice(2)
const doAssert = !argv.includes("--no-assert")
const keep = argv.includes("--keep")
const reuseIndex = argv.indexOf("--reuse")
const reuseDir = reuseIndex === -1 ? undefined : argv[reuseIndex + 1]

if (reuseDir) {
  const out = join(reuseDir, "out")
  const { obs, hookLines } = loadObservations(out)
  if (!obs) {
    console.error(`no observations in ${out}`)
    process.exit(1)
  }
  const runTxt = join(reuseDir, "run.txt")
  const logs = existsSync(runTxt) ? readFileSync(runTxt, "utf8") : ""
  const directoryFile = join(reuseDir, ".directory.json")
  const directory = existsSync(directoryFile)
    ? JSON.parse(readFileSync(directoryFile, "utf8")).directory
    : realpathSync(reuseDir)
  const failed = report(assertContract({ obs, hookLines, logs, directory }), obs)
  process.exit(doAssert && failed.length > 0 ? 1 : 0)
}

const PROJECT = mkdtempSync(join(tmpdir(), "odw-contract-"))
const DIRECTORY = realpathSync(PROJECT)
const OUT = join(PROJECT, "out")
mkdirSync(join(PROJECT, ".opencode/plugins/odw-probe"), { recursive: true })
mkdirSync(OUT, { recursive: true })

writeFileSync(join(PROJECT, ".opencode/plugins/odw-probe/index.ts"), `export { default } from ${JSON.stringify(PROBE)}\n`)
writeFileSync(join(PROJECT, "opencode.json"), `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`)
writeFileSync(join(PROJECT, ".directory.json"), JSON.stringify({ directory: DIRECTORY }))
execFileSync("git", ["init", "-q", "."], { cwd: PROJECT })

// The sentinel makes the probe's prompt hook mutate this very prompt (proves C9).
const PROMPT =
  "ODW-HOOK-TEST. Use Code Mode and run exactly this, then wait for it to finish:\n" +
  'execute {"code": "return await tools.odw.probe({ scenario: \\"all\\" })"}\n' +
  "After it returns, reply with the single word: done"

console.log(`project: ${PROJECT}`)
const run = spawnSync("opencode", ["run", "--standalone", "--auto", "--agent", "build", "--print-logs", PROMPT], {
  cwd: PROJECT,
  encoding: "utf8",
  timeout: 900_000,
  env: {
    ...process.env,
    // opencode resolves the server's location from PWD, not from the child's cwd.
    // Inheriting the caller's PWD silently binds the run to the WRONG project.
    PWD: PROJECT,
    ODW_PROBE_OUT: OUT,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  },
})
writeFileSync(join(PROJECT, "run.txt"), `${run.stdout ?? ""}\n--- stderr ---\n${run.stderr ?? ""}`)
console.log(`opencode exit: ${run.status}`)

const { obs, hookLines } = loadObservations(OUT)
if (!obs) {
  console.error("FAIL: probe produced no observations")
  console.error(readFileSync(join(PROJECT, "run.txt"), "utf8").slice(0, 3000))
  console.log(`kept for inspection: ${PROJECT}`)
  process.exit(1)
}

if (!doAssert) {
  console.log(JSON.stringify(obs, null, 2))
  console.log(`kept for inspection: ${PROJECT}`)
  process.exit(0)
}

const logs = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
const failed = report(assertContract({ obs, hookLines, logs, directory: DIRECTORY }), obs)
if (failed.length > 0) {
  console.log("\n--- raw observations ---")
  console.log(JSON.stringify(obs, null, 2).slice(0, 12_000))
}

if (failed.length === 0 && !keep) rmSync(PROJECT, { recursive: true, force: true })
else console.log(`\nkept for inspection: ${PROJECT}`)
process.exit(failed.length > 0 ? 1 : 0)
