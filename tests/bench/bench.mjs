#!/usr/bin/env node
/**
 * Benchmark: the same N tasks, done three ways.
 *
 *   serial  one opencode session does all N tasks itself
 *   odw     one opencode session runs a workflow: ctx.parallel -> N worker sub-sessions
 *   procs   N separate `opencode run` processes, C at a time (one CLI process per worker)
 *
 * Two workloads (--task):
 *   summary  read one real source file of this repo and summarize it in 5 bullets (default)
 *   line     read fK.txt and reply with its first line - a tiny task that shows fixed overhead
 * Every answer starts with a marker the script can check, so a scenario that "finishes" without
 * doing the work shows up in the correct column.
 *
 * For each scenario it records wall time, the peak RSS / thread count / process count of the
 * whole process tree (sampled every 250 ms), and the tokens of every session the scenario
 * created (read back from opencode's own session table).
 *
 *   node tests/bench/bench.mjs                       # summary, N=8, C=4, 1 round
 *   node tests/bench/bench.mjs --task line --n 8 --c 4 --rounds 3
 *   node tests/bench/bench.mjs --keep                # keep the throwaway projects
 *
 * It runs against an isolated config that holds only the provider of --model and loads ODW
 * from this checkout, so the numbers do not depend on your MCP servers or plugins. The
 * provider's apiKey is passed through an environment variable, never written to disk. Like
 * the contract harness, it never starts opencode inside this repository. The sessions it
 * creates do stay in opencode's session database, under the throwaway project directories.
 */
import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, platform, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}

const TASK = option("--task", "summary")
const N = Number(option("--n", "8"))
const C = Number(option("--c", "4"))
const ROUNDS = Number(option("--rounds", "1"))
const MODEL = option("--model", "compass/deepseek-v4.1-flash")
const SCENARIOS = option("--only", "serial,odw,procs").split(",")
const KEEP = flag("--keep")
const SAMPLE_MS = 250

const WORK = mkdtempSync(join(tmpdir(), "odw-bench-"))
const env = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
isolateConfig()

const WORKLOADS = {
  line: {
    task: "Read the file {file} in this project and reply with its first line only, nothing else.",
    serial:
      "Read each of these files in this project: {files}. " +
      "Reply with the first line of each file, one per line, in the same order, nothing else.",
    setup(dir) {
      const files = []
      const expected = []
      for (let i = 1; i <= N; i++) {
        const first = `bench-line-${i}-${Math.random().toString(36).slice(2, 10)}`
        const filler = Array.from({ length: 20 }, (_, k) => `filler ${i}.${k}`).join("\n")
        writeFileSync(join(dir, `f${i}.txt`), `${first}\n${filler}\n`)
        files.push(`f${i}.txt`)
        expected.push(first)
      }
      return { files, expected }
    },
  },
  summary: {
    task: 'Read the file {file} in this project. Reply with the line "== {file} ==" and then summarize what the file does in exactly 5 bullet points.',
    serial:
      "For each of these files in this project, in this order: {files}. " +
      'Read it, then write the line "== <file path> ==" followed by a summary of what the file does in exactly 5 bullet points.',
    setup(dir) {
      const sources = readdirSync(join(REPO, "src"), { recursive: true })
        .filter((path) => path.endsWith(".ts"))
        .sort()
      if (sources.length < N) throw new Error(`--task summary has only ${sources.length} source files, --n ${N} is too many`)
      const files = sources.slice(0, N).map((path) => `src/${path}`)
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        copyFileSync(join(REPO, file), join(dir, file))
      }
      return { files, expected: files.map((file) => `== ${file} ==`) }
    },
  },
}
const WORKLOAD = WORKLOADS[TASK]
if (!WORKLOAD) throw new Error(`--task must be one of ${Object.keys(WORKLOADS).join(", ")}`)
const task = (file) => WORKLOAD.task.replaceAll("{file}", file)

// ---------------------------------------------------------------- config

function isolateConfig() {
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config")
  const user = JSON.parse(readFileSync(join(configHome, "opencode/opencode.json"), "utf8"))
  const providerID = MODEL.split("/")[0]
  const provider = structuredClone(user.provider?.[providerID])
  if (!provider) throw new Error(`provider ${providerID} is not in your opencode config`)
  const apiKey = provider.options?.apiKey
  if (typeof apiKey === "string" && !apiKey.startsWith("{env:")) {
    env["ODW_BENCH_API_KEY"] = apiKey
    provider.options.apiKey = "{env:ODW_BENCH_API_KEY}"
  }
  const xdg = join(WORK, "xdg")
  mkdirSync(join(xdg, "opencode"), { recursive: true })
  writeFileSync(
    join(xdg, "opencode/opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { [providerID]: provider } }, null, 2),
  )
  env["XDG_CONFIG_HOME"] = xdg
}

// ---------------------------------------------------------------- project

function makeProject(name) {
  const dir = realpathSync(mkdtempSync(join(WORK, `${name}-`)))
  const { files, expected } = WORKLOAD.setup(dir)
  writeFileSync(join(dir, "opencode.json"), `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`)
  // Same mount as the contract harness: a one-line re-export of this checkout.
  mkdirSync(join(dir, ".opencode/plugins/odw"), { recursive: true })
  writeFileSync(join(dir, ".opencode/plugins/odw/index.ts"), `export { default } from ${JSON.stringify(join(REPO, "src/index.ts"))}\n`)
  mkdirSync(join(dir, "workflows"))
  writeFileSync(
    join(dir, "workflows/bench.ts"),
    `export default async (ctx) => {\n` +
      `  const files = ${JSON.stringify(files)}\n` +
      `  const answers = await ctx.parallel(files, (file) =>\n` +
      `    ctx.agent({ label: "task:" + file, prompt: ${JSON.stringify(WORKLOAD.task)}.replaceAll("{file}", file) }),\n` +
      `  )\n` +
      // result.json keeps only the first 2000 characters of the return value; a checkpoint
      // keeps all of it, so every answer can be checked.
      `  await ctx.checkpoint("answers", answers)\n` +
      `  return answers.length\n` +
      `}\n`,
  )
  execFileSync("git", ["init", "-q", "."], { cwd: dir })
  return { dir, files, expected }
}

// ---------------------------------------------------------------- processes

function opencode(dir, prompt) {
  const child = spawn(
    "opencode",
    ["run", "--standalone", "--auto", "--agent", "build", "--model", MODEL, "--format", "json", prompt],
    { cwd: dir, env: { ...env, PWD: dir }, stdio: ["ignore", "pipe", "pipe"] },
  )
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })))
  return { pid: child.pid, done }
}

/** Sum RSS / threads / process count over every tree rooted at `roots`. */
function sampleTrees(roots) {
  if (roots.size === 0) return { rssKB: 0, threads: 0, procs: 0 }
  const linux = platform() === "linux"
  const table = execFileSync("ps", ["-A", "-o", linux ? "pid=,ppid=,rss=,nlwp=" : "pid=,ppid=,rss="], { encoding: "utf8" })
  const rows = table
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
  const children = new Map()
  for (const [pid, ppid] of rows) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const inTree = new Set()
  const stack = [...roots]
  while (stack.length > 0) {
    const pid = stack.pop()
    if (inTree.has(pid)) continue
    inTree.add(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  let rssKB = 0
  let threads = 0
  let procs = 0
  for (const [pid, , rss, nlwp] of rows) {
    if (!inTree.has(pid)) continue
    procs += 1
    rssKB += rss
    if (linux) threads += nlwp
  }
  if (!linux && procs > 0) {
    try {
      const out = execFileSync("ps", ["-M", "-p", [...inTree].join(",")], { encoding: "utf8" })
      threads = out.trim().split("\n").length - 1
    } catch {
      // a process exited between the two ps calls; keep the RSS sample, skip threads
    }
  }
  return { rssKB, threads, procs }
}

function startSampler(roots) {
  const peak = { rssKB: 0, threads: 0, procs: 0 }
  const timer = setInterval(() => {
    const now = sampleTrees(roots)
    peak.rssKB = Math.max(peak.rssKB, now.rssKB)
    peak.threads = Math.max(peak.threads, now.threads)
    peak.procs = Math.max(peak.procs, now.procs)
  }, SAMPLE_MS)
  return () => {
    clearInterval(timer)
    return peak
  }
}

// ---------------------------------------------------------------- tokens

function sessionTokens(dir) {
  const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local/share")
  const db = join(dataHome, "opencode/opencode.db")
  const sql =
    "select count(*) as sessions, sum(tokens_input) as input, sum(tokens_output) as output, " +
    "sum(tokens_reasoning) as reasoning, sum(tokens_cache_read) as cacheRead, " +
    "sum(tokens_cache_write) as cacheWrite, sum(cost) as cost " +
    `from session_v2 where directory = '${dir.replaceAll("'", "''")}'`
  try {
    const [row] = JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8" }))
    return row
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- scenarios

async function runScenario(name) {
  const project = makeProject(name)
  const roots = new Set()
  const stop = startSampler(roots)
  const started = Date.now()
  const outputs = []
  let odwElapsedMs

  if (name === "serial") {
    const prompt =
      WORKLOAD.serial.replace("{files}", project.files.join(", ")) +
      " Do the work yourself in this session: do not use odw, workflows or any sub-agent."
    const run = opencode(project.dir, prompt)
    roots.add(run.pid)
    outputs.push(await run.done)
  } else if (name === "odw") {
    const prompt =
      "Use Code Mode and run exactly this, then wait for it to finish:\n" +
      `execute {"code": "return await tools.odw.run({ file: \\"bench.ts\\", concurrency: ${C} })"}\n` +
      "After it returns, reply with the single word: done"
    const run = opencode(project.dir, prompt)
    roots.add(run.pid)
    outputs.push(await run.done)
    const runsDir = join(project.dir, ".odw/runs")
    for (const runId of safeReaddir(runsDir)) {
      const checkpoints = join(runsDir, runId, "checkpoints")
      for (const file of safeReaddir(checkpoints)) outputs.push({ answer: safeRead(join(checkpoints, file)) })
      odwElapsedMs = JSON.parse(safeRead(join(runsDir, runId, "result.json")) || "{}").elapsedMs
    }
  } else if (name === "procs") {
    const queue = [...project.files]
    const lane = async () => {
      while (queue.length > 0) {
        const run = opencode(project.dir, task(queue.shift()))
        roots.add(run.pid)
        outputs.push(await run.done)
        roots.delete(run.pid)
      }
    }
    await Promise.all(Array.from({ length: Math.min(C, N) }, lane))
  }

  const wallMs = Date.now() - started
  const peak = stop()
  // Only what the model said counts: tool output (the file contents) is in the same stream.
  const text = outputs.map((output) => output.answer ?? modelText(output.stdout)).join("\n")
  const correct = project.expected.filter((line) => text.includes(line)).length
  const failed = outputs.filter((output) => output.code !== undefined && output.code !== 0)
  const failedExits = failed.length
  const lastLines = (text) => text.trim().split("\n").slice(-2).join(" | ")
  const errors = failed.map((output) => `exit ${output.code}: ${lastLines(output.stderr)} ${lastLines(output.stdout)}`)
  const tokens = sessionTokens(project.dir)
  if (!KEEP) rmSync(project.dir, { recursive: true, force: true })
  return { name, wallMs, odwElapsedMs, ...peak, correct, failedExits, errors, tokens, dir: project.dir }
}

function modelText(stdout) {
  const texts = []
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line)
      if (event.type === "text" && typeof event.part?.text === "string") texts.push(event.part.text)
    } catch {
      // not an event line
    }
  }
  return texts.join("\n")
}

const safeReaddir = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
const safeRead = (file) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------- main

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

console.log(`bench: task=${TASK} N=${N} C=${C} rounds=${ROUNDS} model=${MODEL}`)
console.log(`work dir: ${WORK}`)

// Warm-up: the first opencode start pays one-off costs (plugin install, caches) that are
// not what this benchmark is about.
{
  const project = makeProject("warmup")
  const run = opencode(project.dir, "Reply with the single word: ok")
  const result = await run.done
  if (result.code !== 0) {
    console.error(`warm-up failed (exit ${result.code}):\n${result.stderr.slice(0, 2000)}`)
    process.exit(1)
  }
}

const results = []
for (let round = 1; round <= ROUNDS; round++) {
  for (const name of SCENARIOS) {
    const result = await runScenario(name)
    results.push({ round, ...result })
    const t = result.tokens ?? {}
    console.log(
      `round ${round} ${name.padEnd(6)} wall=${(result.wallMs / 1000).toFixed(1)}s ` +
        (result.odwElapsedMs === undefined ? "" : `(odw_run ${(result.odwElapsedMs / 1000).toFixed(1)}s) `) +
        `rss=${Math.round(result.rssKB / 1024)}MB threads=${result.threads} procs=${result.procs} ` +
        `correct=${result.correct}/${N} badExits=${result.failedExits} sessions=${t.sessions} ` +
        `in=${t.input} cacheRead=${t.cacheRead} out=${t.output} reasoning=${t.reasoning}`,
    )
    for (const error of result.errors) console.log(`  ${error.slice(0, 400)}`)
  }
}

writeFileSync(join(WORK, "results.json"), JSON.stringify({ TASK, N, C, ROUNDS, MODEL, results }, null, 2))

console.log(`\n| scenario | wall (s) | peak RSS (MB) | peak threads | peak processes | sessions | input tok | cache-read tok | output tok | correct |`)
console.log(`|---|---|---|---|---|---|---|---|---|---|`)
for (const name of SCENARIOS) {
  const rows = results.filter((row) => row.name === name)
  const pick = (fn) => median(rows.map(fn))
  console.log(
    `| ${name} | ${(pick((r) => r.wallMs) / 1000).toFixed(1)} | ${Math.round(pick((r) => r.rssKB) / 1024)} | ` +
      `${pick((r) => r.threads)} | ${pick((r) => r.procs)} | ${pick((r) => r.tokens?.sessions ?? 0)} | ` +
      `${pick((r) => r.tokens?.input ?? 0)} | ${pick((r) => r.tokens?.cacheRead ?? 0)} | ` +
      `${pick((r) => r.tokens?.output ?? 0)} | ${pick((r) => r.correct)}/${N} |`,
  )
}
console.log(`\nmedians over ${ROUNDS} round(s); raw rows in ${join(WORK, "results.json")}`)
if (!KEEP) rmSync(join(WORK, "xdg"), { recursive: true, force: true })
