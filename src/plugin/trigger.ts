import type { Plugin } from "@opencode/plugin"

/**
 * Intent detection on prompt admission (PLAN D6).
 *
 * The hook is **append-only and advisory**:
 *
 *  - it only appends a hint to `prompt.text`, and only after the ODW marker is
 *    absent (the hook is explicitly *not* exactly-once, so it must be idempotent
 *    by construction - measured: PLAN §1 C6);
 *  - it never rewrites the user's words and never touches `files`/`agents`/`skills`,
 *    whose `mention` offsets are character positions into the original text;
 *  - it never executes anything. Turning it off (`trigger: false`) leaves `/workflow`
 *    and `odw_run` fully functional, because execution lives in the tool.
 *
 * A conservative regex gates the hint: a false positive nags the user on every
 * ordinary message, which is far worse than occasionally not suggesting ODW.
 */

export const ODW_HINT_MARKER = "<!-- odw:hint -->"

export const ODW_HINT = [
  ODW_HINT_MARKER,
  "（上面这个请求看起来是批量/扇出型的。如果确实要把同一件事作用到 N 个对象上，",
  "可以用 `odw_run` 写一个 `async (ctx) => {...}` 脚本并行跑；不确定就按普通方式回答，不必迁就这条提示。）",
].join("\n")

/**
 * Only unambiguous "same thing to many things" phrasing, in both languages the
 * user writes in. Deliberately no bare "compare"/"check" without an object, and
 * no shape that a single-file question would also match.
 */
const INTENT_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "enumerate-all", re: /\b(every|each|all)\s+(file|files|module|modules|test|tests|table|tables|row|rows|item|items|repo|repos|package|packages)\b/i },
  { kind: "explicit-parallel", re: /\b(parallel|in parallel|concurrently|fan[ -]?out|batch(?:ed)?)\b/i },
  { kind: "per-item", re: /\bfor\s+each\s+\w+/i },
  { kind: "zh-batch", re: /(批量|逐个|逐一|每一个|每个|所有的|全部|并行|并发|扇出)/ },
  { kind: "zh-count", re: /(核查|检查|扫描|审查|处理|翻译|改写|转换)\s*\d+\s*(个|张|条|份|篇|行|块)/ },
]

export type TriggerOptions = {
  /** `false` disables hint injection entirely; the rest of ODW is unaffected. */
  readonly trigger?: boolean
}

export function detectWorkflowIntent(text: string): string | null {
  for (const { kind, re } of INTENT_PATTERNS) {
    if (re.test(text)) return kind
  }
  return null
}

/**
 * Pure so it can be unit-tested: given the hook event, returns the event mutated
 * in place, plus whether a hint was injected. Calling it twice with the same text
 * must be a no-op the second time.
 */
export function applyIntentHint(event: {
  prompt?: { text?: string } | undefined
  metadata?: Record<string, unknown> | undefined
}): { injected: boolean; kind: string | null } {
  const text = event.prompt?.text
  if (typeof text !== "string" || text.trim() === "") return { injected: false, kind: null }
  if (text.includes(ODW_HINT_MARKER)) return { injected: false, kind: null }

  const kind = detectWorkflowIntent(text)
  if (kind === null) return { injected: false, kind: null }

  event.prompt!.text = `${text}\n\n${ODW_HINT}`
  event.metadata = { ...(event.metadata ?? {}), odwIntent: { detected: true, kind } }
  return { injected: true, kind }
}

export async function registerPromptHook(
  ctx: Plugin.Context,
  options: TriggerOptions = {},
): Promise<() => Promise<void>> {
  if (options.trigger === false) {
    return async () => undefined
  }

  const registration = await ctx.session.hook("prompt", (event) => {
    try {
      applyIntentHint(event as { prompt?: { text?: string }; metadata?: Record<string, unknown> })
    } catch {
      // A hint is never worth breaking prompt admission for.
    }
  })

  return () => registration.dispose()
}

/** Reads `trigger` out of the plugin's config block, defensively. */
export function readTriggerOption(options: unknown): boolean {
  if (options === null || typeof options !== "object") return true
  const value = (options as Record<string, unknown>)["trigger"]
  return value !== false
}
