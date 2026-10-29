/**
 * Contract probe for opencode 2.1.0.
 *
 * This file is loaded by opencode itself (see tests/contract/opencode-v2/CONTRACT.md),
 * so every assertion here is a real behaviour observation, not a type-level claim.
 *
 * Usage: the harness asks the model to call `odw_probe` with `{ scenario: "all" }`.
 * Results are written to `$ODW_PROBE_OUT/<scenario>.json` (a directory the harness owns).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"

import { Model, Plugin } from "@opencode/plugin"

type Any = any

const OUT = process.env["ODW_PROBE_OUT"] ?? "/tmp/odw-contract-out"
const HOOK_LOG = join(OUT, "prompt-hook.jsonl")
const HOOK_SENTINEL = "ODW-HOOK-TEST"
const HOOK_MARKER = "\n<!-- odw-probe-hook -->"
const HOOK_TOKEN_INSTRUCTION = "\n\n(probe-hook instruction: also include the exact token HOOKOK in your reply)"
const CMD_MARKER = "\n\n(probe-command instruction: also include the exact token ODWCMDOK in your reply)"

mkdirSync(OUT, { recursive: true })

function write(name: string, value: unknown): void {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(value, null, 2))
}

async function attempt(fn: () => Promise<unknown> | unknown): Promise<Any> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    const e = error as Any
    return {
      ok: false,
      errorName: e?.constructor?.name ?? typeof error,
      message: String(e?.message ?? error).slice(0, 400),
      tag: e?._tag ?? undefined,
    }
  }
}

function pickModel(list: Any): { providerID: string; id: string } | undefined {
  const items: Any[] = Array.isArray(list)
    ? list
    : (list?.items ?? list?.data ?? list?.models ?? list?.entries ?? [])
  const usable = items.filter((m) => m?.providerID && (m?.id ?? m?.modelID) && m?.enabled !== false)
  const of = (m: Any) => ({ providerID: m.providerID, id: m.id ?? m.modelID })
  // Free-tier models run out of quota mid-suite, which silently reddens model-dependent
  // checks. Prefer an explicitly named model, then a non-free one.
  const preferred = process.env["ODW_PROBE_MODEL"]
  if (preferred) {
    const want = preferred.split("/")
    const hit = usable.find((m) => m.providerID === want[0] && (m.id ?? m.modelID) === want[1])
    if (hit) return of(hit)
  }
  const paid = usable.filter((m) => !/(^|[-/])free($|[-#])/i.test(String(m.id ?? m.modelID)))
  const first = paid.find((m) => m.providerID === "compass") ?? paid[0] ?? usable[0] ?? items[0]
  if (!first) return undefined
  return of(first)
}

/** C6/C7/C8 need one real worker round-trip. */
async function runWorker(ctx: Any, model: Any, text: string): Promise<Any> {
  const created = await ctx.session.create({ title: "odw-probe-worker", model })
  const before = await attempt(() => ctx.session.context({ sessionID: created.id }))
  const t0 = Date.now()
  const queued = await ctx.session.prompt({ sessionID: created.id, text })
  const immediatelyAfterPrompt = await attempt(() => ctx.session.context({ sessionID: created.id }))
  await ctx.session.wait({ sessionID: created.id })
  const elapsedMs = Date.now() - t0
  const after = await attempt(() => ctx.session.context({ sessionID: created.id }))
  await attempt(() => ctx.session.remove({ sessionID: created.id }))
  return { created, before, immediatelyAfterPrompt, after, elapsedMs, queued, text: String(text) }
}

function summarizeContext(messages: Any): Any {
  if (!Array.isArray(messages)) return { notAnArray: true, raw: messages }
  const assistants = messages.filter((m) => m?.type === "assistant")
  const last = assistants[assistants.length - 1]
  const text = Array.isArray(last?.content)
    ? last.content.filter((c: Any) => c?.type === "text").map((c: Any) => c.text).join("")
    : undefined
  return {
    count: messages.length,
    types: messages.map((m) => m?.type),
    lastAssistantText: text,
    lastAssistantTokens: last?.tokens,
    lastAssistantCost: last?.cost,
    lastAssistantModel: last?.model,
    lastAssistantFinish: last?.finish,
    lastAssistantError: last?.error,
    idleOutcome: messages.find((m) => m?.type === "idle")?.outcome,
  }
}

async function runAll(ctx: Any, toolContext: Any): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  out["c1-runtime"] = {
    opencode: ctx.app.version,
    appName: ctx.app.name,
    channel: ctx.app.channel,
    directory: ctx.location.directory,
    projectId: ctx.location.project.id,
    hasOptions: typeof ctx.options === "object",
  }

  // C2 - ctx surface
  const expected = [
    "app", "location", "options", "agent", "aisdk", "command", "credential", "event", "experimental",
    "generate", "model", "provider", "integration", "mcp", "permission", "plugin", "reference", "rpc",
    "skill", "storage", "tool", "vcs", "websearch", "worktree", "session", "shell",
  ]
  const actual = Object.keys(ctx)
  out["c2-ctx-domains"] = {
    missing: expected.filter((k) => !actual.includes(k)),
    extra: actual.filter((k) => !expected.includes(k)),
    sessionMembers: Object.keys(ctx.session ?? {}).sort(),
    experimentalMembers: Object.keys(ctx.experimental ?? {}).sort(),
    generateMembers: Object.keys(ctx.generate ?? {}).sort(),
    sessionGenerateMembers: Object.keys(ctx.session?.generate ?? {}).sort(),
    topLevelValueTypes: Object.fromEntries(
      actual.map((k) => [k, ctx[k] === null ? "null" : Array.isArray(ctx[k]) ? "array" : typeof ctx[k]]),
    ),
  }

  const models = await attempt(() => ctx.model.list())
  const agents = await attempt(() => ctx.agent.list())
  const unwrap = (v: Any): Any[] =>
    Array.isArray(v) ? v : (v?.items ?? v?.data ?? v?.models ?? v?.agents ?? v?.entries ?? [])
  const model = pickModel(models.ok ? models.value : undefined)
  const modelItems = unwrap(models.ok ? models.value : undefined)
  const agentItems = unwrap(agents.ok ? agents.value : undefined)
  out["c2b-inventory"] = {
    modelListOk: models.ok,
    modelListRawKeys: models.ok ? (Array.isArray(models.value) ? "(array)" : Object.keys(models.value ?? {}).sort()) : models,
    modelCount: modelItems.length,
    modelIds: modelItems.map((m: Any) => `${m?.providerID ?? "?"}/${m?.id ?? m?.modelID ?? "?"}${m?.variant ? `#${m.variant}` : ""}`),
    firstModelKeys: modelItems[0] ? Object.keys(modelItems[0]).sort() : undefined,
    agentListOk: agents.ok,
    agentListRawKeys: agents.ok ? (Array.isArray(agents.value) ? "(array)" : Object.keys(agents.value ?? {}).sort()) : agents,
    agentCount: agentItems.length,
    agentIds: agentItems.map((a: Any) => a?.id ?? a?.name),
    firstAgentKeys: agentItems[0] ? Object.keys(agentItems[0]).sort() : undefined,
    sessionGenerateType: typeof ctx.session?.generate,
    modelRef: model,
  }

  // C21 - the skill registry. The harness writes a skill fixture at
  // `.opencode/skills/odw-contract-probe/SKILL.md`; this records whether the host turned it
  // into a registry entry (name/description from the frontmatter, body loaded) - which is the
  // whole natural-language trigger surface of ODW.
  const skills = await attempt(() => ctx.skill.list())
  const skillItems = unwrap(skills.ok ? skills.value : undefined)
  out["c21-skill-registry"] = {
    domainMembers: Object.keys(ctx.skill ?? {}).sort(),
    listOk: skills.ok,
    listRawKeys: skills.ok
      ? Array.isArray(skills.value)
        ? "(array)"
        : Object.keys(skills.value ?? {}).sort()
      : skills,
    count: skillItems.length,
    names: skillItems.map((s: Any) => s?.name).slice(0, 120),
    firstKeys: skillItems[0] ? Object.keys(skillItems[0]).sort() : undefined,
    fixture: skillItems.find((s: Any) => s?.name === "odw-contract-probe") ?? null,
  }

  // C3 - Model.Ref shape
  const refProbe = {
    goodPair: await attempt(() => ctx.session.create({ model: model ? { providerID: model.providerID, id: model.id } : undefined })),
    idOnly: await attempt(() => ctx.session.create({ model: { id: "x" } as Any })),
    providerIDPlusModelID: await attempt(() => ctx.session.create({ model: { providerID: "x", modelID: "y" } as Any })),
    parse: await attempt(() => (Model as Any).Ref.parse("compass/some-model#high")),
    parseNoVariant: await attempt(() => (Model as Any).Ref.parse("compass/some-model")),
  }
  // drop the sessions we created while probing
  for (const key of ["goodPair"]) {
    const r = refProbe[key as keyof typeof refProbe] as Any
    if (r?.ok && r.value?.id) await attempt(() => ctx.session.remove({ sessionID: r.value.id }))
  }
  out["c3-model-ref"] = refProbe

  // C4 - session.create surface
  const c4: Any = {}
  const created: string[] = []
  const a = await attempt(() => ctx.session.create({ title: "odw-c4-a" }))
  if (a.ok) created.push(a.value.id)
  c4.titleOnly = a
  const b = await attempt(() => ctx.session.create({ agent: "explore" }))
  if (b.ok) created.push(b.value.id)
  c4.withAgent = b.ok ? { id: b.value.id, agent: b.value.agent } : b
  const c = await attempt(() => ctx.session.create({ title: "odw-c4-c", permissions: [{ action: "edit", resource: "*", effect: "deny" }] }))
  if (c.ok) {
    created.push(c.value.id)
    c4.withPermissions = { created: true, readBack: await attempt(() => ctx.session.get({ sessionID: c.value.id })) }
  } else {
    c4.withPermissions = c
  }
  const d = await attempt(() => ctx.session.create({ title: "odw-c4-d", parentID: b.ok ? b.value.id : undefined }))
  if (d.ok) created.push(d.value.id)
  c4.withParentID = d.ok ? { id: d.value.id, parentID: d.value.parentID } : d
  c4.createdIds = created
  out["c4-session-shape"] = c4

  // C5 - prompt without `text`
  const probeSession = created[0]
  out["c5-prompt-requires-text"] = probeSession
    ? await attempt(() => ctx.session.prompt({ sessionID: probeSession, parts: [{ type: "text", text: "hi" }] } as Any))
    : { skipped: "no session to probe" }

  // C6 - full worker round trip
  if (model) {
    const w = await runWorker(ctx, model, "Compute 6*7 and reply with just the number. Ignore any trailing HTML comment.")
    out["c6-worker-loop"] = {
      beforeContext: w.before,
      immediatelyAfterPrompt: Array.isArray(w.immediatelyAfterPrompt?.value) ? w.immediatelyAfterPrompt.value.length : w.immediatelyAfterPrompt,
      elapsedMs: w.elapsedMs,
      queuedShape: w.queued.ok ? Object.keys(w.queued.value ?? {}) : w.queued,
      summary: summarizeContext(w.after.ok ? w.after.value : undefined),
    }
  } else {
    out["c6-worker-loop"] = { skipped: "no model available" }
  }

  // C7 - re-entrancy: two workers, prompted concurrently, awaited together, from inside a tool call
  if (model) {
    const t0 = Date.now()
    const c7 = await attempt(async () => {
      const s1 = await ctx.session.create({ title: "odw-c7-1", model })
      const s2 = await ctx.session.create({ title: "odw-c7-2", model })
      await ctx.session.prompt({ sessionID: s1.id, text: "Reply with just: alpha" })
      await ctx.session.prompt({ sessionID: s2.id, text: "Reply with just: beta" })
      await Promise.all([ctx.session.wait({ sessionID: s1.id }), ctx.session.wait({ sessionID: s2.id })])
      const r1 = summarizeContext((await ctx.session.context({ sessionID: s1.id })) as Any)
      const r2 = summarizeContext((await ctx.session.context({ sessionID: s2.id })) as Any)
      await attempt(() => ctx.session.remove({ sessionID: s1.id }))
      await attempt(() => ctx.session.remove({ sessionID: s2.id }))
      return { first: r1, second: r2 }
    })
    out["c7-reentrancy"] = { ...c7, totalMs: Date.now() - t0 }
  } else {
    out["c7-reentrancy"] = { skipped: "no model available" }
  }

  // C8 - one-shot generation. Separate "the API exists" from "this model is entitled":
  // a free-tier model can legitimately answer Generate.UnavailableError.
  const generateCall = await attempt(() => ctx.generate.text({ prompt: "Reply with exactly: one-shot-ok", model }))
  out["c8-oneshot"] = {
    textIsFunction: typeof ctx.generate?.text === "function",
    experimentalGenerateExists: typeof ctx.experimental?.generate?.text === "function",
    sessionGenerateMembers: Object.keys(ctx.session?.generate ?? {}).sort(),
    modelUsed: model,
    call: generateCall,
    unavailableIsTyped: generateCall.ok === false && generateCall.tag === "Generate.UnavailableError",
  }

  // C10 - permission rules round-trip via session.update
  if (probeSession) {
    out["c10-permission-update"] = {
      update: await attempt(() =>
        ctx.session.update({ sessionID: probeSession, permissions: [{ action: "shell", resource: "*", effect: "deny" }] }),
      ),
      readBack: await attempt(() => ctx.session.get({ sessionID: probeSession })),
    }
  }

  // C11 - node:vm capability gate (runs inside whichever runtime the opencode server embeds)
  const vmProbe: Any = { runtime: process.versions }
  vmProbe.createContext = await attempt(() => {
    const c = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })
    new vm.Script("globalThis.x = 1 + 1").runInContext(c, { timeout: 1000 })
    return (c as Any).x
  })
  vmProbe.codegenStringsBlocked = await attempt(() => {
    const c = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })
    new vm.Script("eval('1+1')").runInContext(c, { timeout: 1000 })
    return "NOT BLOCKED"
  })
  vmProbe.timeoutInterruptsSyncLoop = await attempt(() => {
    const c = vm.createContext({})
    new vm.Script("while(true){}").runInContext(c, { timeout: 300 })
    return "NOT INTERRUPTED"
  })
  vmProbe.crossRealmPromise = await attempt(async () => {
    const c = vm.createContext({})
    const thenable = new vm.Script("(async () => 7)()").runInContext(c, { timeout: 1000 })
    return { awaitedFromHost: await thenable, instanceofHostPromise: thenable instanceof Promise }
  })
  vmProbe.hostAsyncBridge = await attempt(async () => {
    // This is the ScriptHost bridging pattern: primitives handed into the sandbox
    // must be awaitable from inside it, and their results must come back out.
    const c = vm.createContext({ hostFn: async (x: number) => x + 1 })
    return await new vm.Script("hostFn(41)").runInContext(c, { timeout: 1000 })
  })
  vmProbe.hostModuleReachable = { requireInContext: await attempt(() => {
    const c = vm.createContext({})
    return new vm.Script("typeof require").runInContext(c, { timeout: 1000 })
  }) }
  // The actual ScriptHost invocation pattern: call the compiled async fn INSIDE the
  // sandbox so runInContext's timeout also covers the body's synchronous prefix.
  vmProbe.asyncFnSyncLoopTimeout = await attempt(() => {
    const c = vm.createContext({})
    return new vm.Script("(async () => { while(true){} })()").runInContext(c, { timeout: 300 })
  })
  // ...and the sandbox must be able to await a HOST promise (every primitive is one).
  vmProbe.awaitHostPromiseInsideSandbox = await attempt(async () => {
    const c = vm.createContext({
      hostAsync: async () => {
        await new Promise((r) => setTimeout(r, 10))
        return "from-host"
      },
    })
    return await new vm.Script("(async () => await hostAsync())()").runInContext(c, { timeout: 2000 })
  })
  vmProbe.sandboxAwaitRejection = await attempt(async () => {
    const c = vm.createContext({
      hostReject: async () => {
        throw new Error("host-boom")
      },
    })
    return await new vm.Script("(async () => { try { await hostReject() } catch (e) { return e.message } })()").runInContext(
      c,
      { timeout: 2000 },
    )
  })
  out["c11-vm-capabilities"] = vmProbe

  // C12 - tool progress
  out["c12-progress"] = await attempt(() => toolContext.progress({ phase: "probe", scenario: "all" }))
  out["c12-signal"] = { isAbortSignal: toolContext.signal instanceof AbortSignal, aborted: toolContext.signal.aborted }

  // C13 - synthetic message into the probing session
  out["c13-synthetic"] = await attempt(() =>
    ctx.session.synthetic({ sessionID: toolContext.sessionID, text: "[odw-probe] synthetic message from the contract probe" }),
  )

  // C9d - does the prompt-hook's text mutation actually reach the model? Test it on a
  // dedicated session and read the answer back from the session store, so the result
  // does not depend on how the CLI happened to build the top-level prompt.
  out["c9d-hook-propagation"] = model
    ? await attempt(async () => {
        const s = await ctx.session.create({ title: "odw-c9d", model })
        await ctx.session.prompt({ sessionID: s.id, text: `${HOOK_SENTINEL}: reply with the single word done` })
        await ctx.session.wait({ sessionID: s.id })
        const messages = (await ctx.session.context({ sessionID: s.id })) as Any
        const all = Array.isArray(messages) ? messages : []
        const texts = all.filter((m) => m?.type === "user").map((m) => String(m?.text ?? ""))
        const mine = texts.find((t) => t.includes(HOOK_SENTINEL))
        const summary = summarizeContext(messages)
        await attempt(() => ctx.session.remove({ sessionID: s.id }))
        return {
          userMessageCount: texts.length,
          storedPromptLength: mine?.length,
          hasHookMarker: mine?.includes("<!-- odw-probe-hook -->"),
          hookMarkerCount: (mine?.match(/odw-probe-hook/g) ?? []).length,
          hasHookTokenInstruction: mine?.includes("HOOKOK"),
          tail: mine?.slice(-200),
          lastAssistantText: summary.lastAssistantText,
          modelSawHookToken: String(summary.lastAssistantText ?? "").toUpperCase().includes("HOOKOK"),
        }
      })
    : { skipped: "no model available" }

  // C17 - command registration + invocation. `session.command` is the backend the TUI
  // uses for `/name args`; `opencode run "/name args"` does NOT route here (measured:
  // it sends the text as a plain user prompt). Both facts shape ODW's `/workflow`.
  const probeCommand = async (name: string, text: string): Promise<Any> => {
    const s = await ctx.session.create({ title: `odw-${name}`, model })
    const invoked = await attempt(() => ctx.session.command({ sessionID: s.id, name, text }))
    const waitOutcome = await Promise.race([
      ctx.session.wait({ sessionID: s.id }).then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timeout-60s"), 60_000)),
    ])
    const messages = (await ctx.session.context({ sessionID: s.id })) as Any
    const all = Array.isArray(messages) ? messages : []
    const texts = all.filter((m) => m?.type === "user").map((m) => String(m?.text ?? ""))
    const summary = summarizeContext(messages)
    await attempt(() => ctx.session.remove({ sessionID: s.id }))
    return {
      invokedOk: invoked.ok,
      invokedError: invoked.ok ? undefined : invoked.message,
      waitOutcome,
      userMessageCount: texts.length,
      userTexts: texts.map((t) => t.slice(-160)),
      lastAssistantText: summary.lastAssistantText,
      idleOutcome: summary.idleOutcome,
    }
  }

  out["c17-command"] = model
    ? await attempt(async () => {
        const listed = await attempt(() => ctx.command.list())
        const listItems: Any[] = Array.isArray(listed.ok ? listed.value : undefined)
          ? (listed.value as Any[])
          : (((listed.ok ? listed.value?.data : undefined) ?? []) as Any[])
        const observe = await probeCommand("odw-probe-cmd", "reply with the single word done")
        const enqueue = await probeCommand("odw-probe-cmd2", "ODWCMD2-SENTINEL")
        const userTexts: string[] = Array.isArray(observe.userTexts) ? observe.userTexts : []
        const enqueueTexts: string[] = Array.isArray(enqueue.userTexts) ? enqueue.userTexts : []
        return {
          listOk: listed.ok,
          listNames: listItems.map((c: Any) => `${c?.name}`),
          registrationVisibleInList: listItems.some((c: Any) => c?.name === "odw-probe-cmd"),
          observe,
          enqueue,
          mutationAutoDelivered: userTexts.some((t) => t.includes("ODWCMDOK")),
          enqueueEnqueuedTextStored: enqueueTexts.some((t) => t.includes("ODWCMD2SELF")),
          enqueueModelSaw: String(enqueue.lastAssistantText ?? "").toUpperCase().includes("ODWCMD2SELF"),
        }
      })
    : { skipped: "no model available" }

  // C18 - what the sandbox actually exposes (the capability fence, not just `require`)
  out["c18-sandbox-globals"] = await (async () => {
    const names = [
      "process", "require", "module", "exports", "__dirname", "__filename", "globalThis", "console",
      "fetch", "setTimeout", "setInterval", "queueMicrotask", "Promise", "JSON", "Math", "Date", "Object",
      "Function", "eval", "Proxy", "Reflect", "WebAssembly", "Buffer", "TextEncoder", "URL", "crypto",
      "structuredClone", "ImportMeta", "opencode",
    ]
    const c = vm.createContext({ console: { log() {} } }, { codeGeneration: { strings: false, wasm: false } })
    const result: Any = await attempt(() =>
      new vm.Script(`(${JSON.stringify(names)}).map(n => n + "=" + typeof globalThis[n]).join(" ")`).runInContext(c, {
        timeout: 2000,
      }),
    )
    return result
  })()

  for (const id of created) await attempt(() => ctx.session.remove({ sessionID: id }))
  return out
}

export default Plugin.define({
  id: "odw-probe",
  async setup(ctx) {
    const hookRegistration = await ctx.session.hook("prompt", (event: Any) => {
      const record: Any = {
        at: new Date().toISOString(),
        sessionID: event.sessionID,
        eventKeys: Object.keys(event ?? {}).sort(),
        promptKeys: Object.keys(event?.prompt ?? {}).sort(),
        originalText: event.prompt?.text,
        hadMetadata: event.metadata !== undefined,
        delivery: event.delivery,
      }
      if (typeof event.prompt?.text === "string" && event.prompt.text.includes(HOOK_SENTINEL)) {
        const alreadyInjected = event.prompt.text.includes(HOOK_MARKER)
        event.prompt.text = event.prompt.text + HOOK_MARKER + HOOK_TOKEN_INSTRUCTION
        event.metadata = { ...(event.metadata ?? {}), odwProbe: { injected: true, alreadyInjected } }
        record.injected = true
        record.alreadyInjected = alreadyInjected
        record.injectedCount = (event.prompt.text.match(/odw-probe-hook/g) ?? []).length
      }
      appendFileSync(HOOK_LOG, `${JSON.stringify(record)}\n`)
    })

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "probe",
        description:
          "opencode-dynamic-workflow contract probe. Call it with scenario='all' to run the full API contract battery and write the raw observations to disk. It makes a few real model calls.",
        options: { namespace: "odw", codemode: true },
        input: {
          type: "object",
          properties: { scenario: { type: "string" } },
          required: ["scenario"],
          additionalProperties: false,
        },
        execute: async (input: Any, toolContext: Any) => {
          const scenario = input?.scenario ?? "all"
          try {
            const result = await runAll(ctx, toolContext)
            write(scenario, result)
            return { content: `probe wrote ${scenario}.json (${Object.keys(result).length} observations)` }
          } catch (error) {
            write(`${scenario}-fatal`, { message: String((error as Any)?.message ?? error) })
            return { content: `probe failed: ${String((error as Any)?.message ?? error)}` }
          }
        },
      })
    })

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "odw-probe-cmd",
        description: "Contract probe command: records its invocation and appends a token instruction to the prompt (observe-only).",
        execute: async (invocation: Any) => {
          write("command-invocation", {
            at: new Date().toISOString(),
            sessionID: invocation?.sessionID,
            delivery: invocation?.delivery,
            invocationKeys: Object.keys(invocation ?? {}).sort(),
            promptKeys: Object.keys(invocation?.prompt ?? {}).sort(),
            receivedText: invocation?.prompt?.text,
          })
          if (typeof invocation?.prompt?.text === "string" && !invocation.prompt.text.includes("ODWCMDOK")) {
            invocation.prompt.text = invocation.prompt.text + CMD_MARKER
          }
          appendFileSync(HOOK_LOG, `${JSON.stringify({ at: new Date().toISOString(), kind: "command-executed" })}\n`)
        },
      })
      // The pattern ODW's `/workflow` actually needs: the command enqueues a prompt into
      // its own session (the re-entrant path C7 proved for tools - but from the command
      // admission path, which is a different entry point).
      editor.add({
        name: "odw-probe-cmd2",
        description: "Contract probe command that enqueues a follow-up prompt into its own session.",
        execute: async (invocation: Any) => {
          write("command-invocation2", {
            at: new Date().toISOString(),
            sessionID: invocation?.sessionID,
            delivery: invocation?.delivery,
            receivedText: invocation?.prompt?.text,
          })
          const res = await attempt(() =>
            ctx.session.prompt({
              sessionID: invocation?.sessionID,
              text: "reply with the single word done and then append the exact token ODWCMD2SELF",
            }),
          )
          write("command-enqueue-result", res)
        },
      })
    })

    return async () => {
      await hookRegistration.dispose()
      await toolRegistration.dispose()
      await commandRegistration.dispose()
    }
  },
})
