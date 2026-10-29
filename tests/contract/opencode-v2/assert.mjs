/** Assertions over the raw observations written by probe.ts. Shared by run.mjs and the vitest test. */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const okOf = (v) => v?.ok === true
const errOf = (v) => v?.ok === false

/**
 * @param {{ obs: any, hookLines: any[], logs: string, directory: string }} input
 * @returns {{ id: string, description: string, ok: boolean, detail?: unknown }[]}
 */
export function assertContract({ obs, hookLines, logs, directory }) {
  const results = []
  const check = (id, description, ok, detail) => results.push({ id, description, ok: Boolean(ok), detail })
  const get = (k) => obs[k]

  // C1 - the probe loaded and executed on the host server
  check("C1a", "probe plugin loaded + tool executed", Boolean(obs["c1-runtime"]), get("c1-runtime"))
  check(
    "C1b",
    "no 'must be a directory' WARN for the probe plugin",
    !logs.split("\n").some((l) => l.includes("must be a directory") && l.includes("odw-probe")),
  )
  check("C1c", "server bound to the throwaway project", String(get("c1-runtime")?.directory ?? "") === directory, {
    got: get("c1-runtime")?.directory,
    want: directory,
  })

  // C2 - ctx surface
  const domains = get("c2-ctx-domains") ?? {}
  check("C2a", "all expected ctx domains present", (domains.missing ?? ["?"]).length === 0, {
    missing: domains.missing,
    extra: domains.extra,
  })
  check(
    "C2b",
    "ctx.experimental has NO generate (only terminal)",
    Array.isArray(domains.experimentalMembers) && !domains.experimentalMembers.includes("generate"),
    domains.experimentalMembers,
  )
  check(
    "C2c",
    "ctx.generate.text exists",
    get("c2-ctx-domains")?.topLevelValueTypes?.generate === "object" && get("c8-oneshot")?.textIsFunction === true,
    get("c8-oneshot"),
  )

  // C3 - Model.Ref
  const ref = get("c3-model-ref") ?? {}
  check("C3a", "create({providerID,id}) accepted", okOf(ref.goodPair), ref.goodPair)
  check("C3b", "create({id} only) rejected", errOf(ref.idOnly), ref.idOnly)
  check("C3c", "create({providerID,modelID}) rejected", errOf(ref.providerIDPlusModelID), ref.providerIDPlusModelID)
  check("C3d", "Model.Ref.parse('p/m#v') -> providerID/id/variant", okOf(ref.parse) && ref.parse.value?.variant === "high", ref.parse)

  // C4 - create surface
  const c4 = get("c4-session-shape") ?? {}
  check("C4a", "create({title}) -> id", okOf(c4.titleOnly) && typeof c4.titleOnly.value?.id === "string", c4.titleOnly)
  check("C4b", "create({agent:'explore'}) -> agent echoed", c4.withAgent?.agent === "explore", c4.withAgent)
  check("C4c", "create({permissions:[deny edit]}) accepted", c4.withPermissions?.created === true, c4.withPermissions)
  check("C4d", "create({parentID}) accepted", c4.withParentID?.id !== undefined, c4.withParentID)

  // C5
  check("C5", "prompt without `text` rejected", errOf(get("c5-prompt-requires-text")), get("c5-prompt-requires-text"))

  // C6 - the core worker loop
  const c6 = get("c6-worker-loop") ?? {}
  check("C6a", "context empty right after prompt", c6.immediatelyAfterPrompt === 0, c6.immediatelyAfterPrompt)
  check(
    "C6b",
    "wait() -> assistant text says 42",
    typeof c6.summary?.lastAssistantText === "string" && c6.summary.lastAssistantText.includes("42"),
    c6.summary?.lastAssistantText,
  )
  check("C6c", "assistant carries tokens", Boolean(c6.summary?.lastAssistantTokens), c6.summary?.lastAssistantTokens)
  check("C6d", "round trip produced >=3 messages", c6.summary?.count >= 3, {
    count: c6.summary?.count,
    types: c6.summary?.types,
  })

  // C7 - re-entrancy: the architecture-level gate
  const c7 = get("c7-reentrancy") ?? {}
  check("C7a", "2 concurrent workers from inside a tool call", okOf(c7), c7.message)
  check(
    "C7b",
    "both workers produced text",
    Boolean(c7.value?.first?.lastAssistantText) && Boolean(c7.value?.second?.lastAssistantText),
    { first: c7.value?.first?.lastAssistantText, second: c7.value?.second?.lastAssistantText },
  )
  check("C7c", "finished within 120s", typeof c7.totalMs === "number" && c7.totalMs < 120_000, c7.totalMs)

  // C8 - one-shot generation
  const c8 = get("c8-oneshot") ?? {}
  check("C8a", "ctx.generate.text exists and is callable", c8.textIsFunction === true, c8)
  check("C8b", "ctx.experimental.generate does NOT exist in this build", c8.experimentalGenerateExists === false, {
    experimentalGenerateExists: c8.experimentalGenerateExists,
  })
  check(
    "C8c",
    "generate() either succeeds or is a typed UnavailableError (quota), not a shape error",
    c8.call?.ok === true || c8.unavailableIsTyped === true,
    c8.call,
  )

  // C10
  const c10 = get("c10-permission-update") ?? {}
  check("C10a", "session.update({permissions}) accepted", okOf(c10.update), c10.update)
  check("C10b", "deny rule readable back", okOf(c10.readBack) && JSON.stringify(c10.readBack.value ?? {}).includes("deny"), undefined)

  // C11 - node:vm capability gate (the A-tier ScriptHost fence, see CONTRACT.md §3.5)
  const c11 = get("c11-vm-capabilities") ?? {}
  check("C11a", "vm.createContext + Script works", okOf(c11.createContext) && c11.createContext.value === 2, c11.createContext)
  check("C11b", "codeGeneration strings:false blocks eval", errOf(c11.codegenStringsBlocked), c11.codegenStringsBlocked)
  check("C11c", "runInContext({timeout}) interrupts `while(true)`", errOf(c11.timeoutInterruptsSyncLoop), c11.timeoutInterruptsSyncLoop)
  check(
    "C11d",
    "host can await a vm-realm promise (cross-realm thenable works)",
    c11.crossRealmPromise?.ok === true && c11.crossRealmPromise.value?.awaitedFromHost === 7,
    c11.crossRealmPromise,
  )
  check(
    "C11e",
    "host async fn bridged into the sandbox is awaitable from inside",
    c11.hostAsyncBridge?.ok === true && c11.hostAsyncBridge.value === 42,
    c11.hostAsyncBridge,
  )
  check(
    "C11f",
    "sandbox has no ambient `require` (capability fence holds)",
    c11.hostModuleReachable?.requireInContext?.ok === true && c11.hostModuleReachable.requireInContext.value === "undefined",
    c11.hostModuleReachable,
  )
  check(
    "C11g",
    "runInContext timeout also covers an async fn body's synchronous prefix",
    errOf(c11.asyncFnSyncLoopTimeout),
    c11.asyncFnSyncLoopTimeout,
  )
  check(
    "C11h",
    "sandbox can await a host promise (the ScriptHost primitive bridge)",
    c11.awaitHostPromiseInsideSandbox?.ok === true && c11.awaitHostPromiseInsideSandbox.value === "from-host",
    c11.awaitHostPromiseInsideSandbox,
  )
  check(
    "C11i",
    "sandbox catches host promise rejection",
    c11.sandboxAwaitRejection?.ok === true && c11.sandboxAwaitRejection.value === "host-boom",
    c11.sandboxAwaitRejection,
  )

  // C12 / C13 - feedback channels
  check("C12a", "tool progress() callable", okOf(get("c12-progress")), get("c12-progress"))
  check("C12b", "tool context exposes an AbortSignal", get("c12-signal")?.isAbortSignal === true, get("c12-signal"))
  check("C13", "session.synthetic() callable", okOf(get("c13-synthetic")), get("c13-synthetic"))

  // C9 - prompt hook
  const injected = hookLines.filter((l) => l.injected === true)
  check("C9a", "session.hook('prompt') fired", hookLines.length > 0, { hookFirings: hookLines.length })
  check("C9b", "hook can append text + set metadata", injected.length > 0, injected.slice(0, 2))
  check(
    "C9c",
    "re-entrant hook invocation does not double-append (marker appears once per event)",
    injected.length > 0 && injected.every((l) => l.injectedCount === 1),
    injected.map((l) => l.injectedCount),
  )
  const delivered = get("c9d-hook-propagation")?.value ?? {}
  check(
    "C9d",
    "hook's text mutation reached the stored prompt (marker appears exactly once)",
    delivered.hasHookMarker === true && delivered.hookMarkerCount === 1,
    delivered,
  )
  check(
    "C9e",
    "the model actually acted on the hook-injected instruction",
    delivered.modelSawHookToken === true,
    { lastAssistantText: delivered.lastAssistantText },
  )

  // C17 - command registration + invocation
  const cmd = get("c17-command")?.value ?? {}
  const cmdFile = join(directory, "out", "command-invocation.json")
  const cmd2File = join(directory, "out", "command-invocation2.json")
  const cmdWritten = existsSync(cmdFile) ? JSON.parse(readFileSync(cmdFile, "utf8")) : undefined
  const cmd2Written = existsSync(cmd2File) ? JSON.parse(readFileSync(cmd2File, "utf8")) : undefined
  check("C17a", "command.transform registration + command.list() succeed", cmd.listOk === true, { listOk: cmd.listOk })
  check("C17b", "registered command is visible in command.list() (TUI can see it)", cmd.registrationVisibleInList === true, cmd.listNames)
  check("C17c", "session.command() invoked the command", Boolean(cmdWritten), { cmdWritten, invokedError: cmd.observe?.invokedError })
  check("C17d", "command received the caller's text as prompt.text", cmdWritten?.receivedText === "reply with the single word done", cmdWritten)
  check(
    "C17e",
    "MEASURED: mutating invocation.prompt.text does NOT by itself deliver a prompt",
    cmd.mutationAutoDelivered === false && cmd.observe?.userMessageCount === 0,
    cmd.observe,
  )
  check(
    "C17f",
    "command.execute() can enqueue a prompt into its own session (re-entrant)",
    cmd2Written !== undefined && cmd.enqueueEnqueuedTextStored === true,
    { enqueue: cmd.enqueue, cmd2Written },
  )
  check("C17g", "the model acted on the command-enqueued prompt", cmd.enqueueModelSaw === true, {
    lastAssistantText: cmd.enqueue?.lastAssistantText,
    waitOutcome: cmd.enqueue?.waitOutcome,
  })

  // C18 - sandbox globals
  const sandbox = get("c18-sandbox-globals") ?? {}
  check("C18", "sandbox globals probed", typeof sandbox.value === "string", sandbox)
  const globals = Object.fromEntries(
    String(sandbox.value ?? "")
      .split(" ")
      .map((pair) => pair.split("=")),
  )
  check("C18a", "no process/require/module/Buffer in the sandbox", globals.process === "undefined" && globals.require === "undefined" && globals.module === "undefined" && globals.Buffer === "undefined", globals)
  check("C18b", "sandbox has its own standard built-ins", globals.Promise === "function" && globals.JSON === "object" && globals.Object === "function", globals)
  check("C18c", "eval is still a function but codeGeneration blocks it (see C11b)", globals.eval === "function", globals)

  // C21 - skill discovery: the mechanism ODW's natural-language trigger depends on.
  // The harness plants `.opencode/skills/odw-contract-probe/SKILL.md` in the throwaway project
  // and checks the host registered it with the frontmatter name/description and the body loaded.
  const c21 = get("c21-skill-registry") ?? {}
  const fixture = c21.fixture ?? {}
  check(
    "C21a",
    "ctx.skill.list() returns the skill registry",
    c21.listOk === true && typeof c21.count === "number",
    { listOk: c21.listOk, listRawKeys: c21.listRawKeys, count: c21.count },
  )
  check(
    "C21b",
    "project skill at .opencode/skills/<name>/SKILL.md is registered",
    Boolean(c21.fixture),
    { names: c21.names },
  )
  check("C21c", "registry name comes from the frontmatter", fixture.name === "odw-contract-probe", fixture.name)
  check("C21d", "registry id is present", typeof fixture.id === "string" && fixture.id.length > 0, fixture.id)
  check(
    "C21e",
    "registry description comes from the frontmatter",
    typeof fixture.description === "string" && fixture.description.includes("Contract fixture"),
    fixture.description,
  )
  check(
    "C21f",
    "skill body is loaded into the registry (the model gets content, not just a name)",
    typeof fixture.content === "string" && fixture.content.includes("odw-contract-skill-body-marker"),
    typeof fixture.content === "string" ? fixture.content.slice(0, 200) : fixture.content,
  )
  check(
    "C21g",
    "registry path points at the project skill file",
    String(fixture.path ?? "").endsWith(".opencode/skills/odw-contract-probe/SKILL.md"),
    fixture.path,
  )

  return results
}

export function loadObservations(outDir) {
  const obsFile = join(outDir, "all.json")
  const hookFile = join(outDir, "prompt-hook.jsonl")
  return {
    obs: existsSync(obsFile) ? JSON.parse(readFileSync(obsFile, "utf8")) : undefined,
    hookLines: existsSync(hookFile)
      ? readFileSync(hookFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [],
  }
}

export function report(results, obs) {
  const width = Math.max(...results.map((r) => r.description.length))
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(5)} ${r.description.padEnd(width)}`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    console.log("\n--- failing detail ---")
    for (const f of failed) console.log(`${f.id}: ${JSON.stringify(f.detail ?? null).slice(0, 700)}`)
  }
  return failed
}

export { okOf, errOf }
