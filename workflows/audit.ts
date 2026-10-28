/**
 * Example workflow: audit a handful of files, then verify the audit itself.
 *
 * This is the `file` carrier - the model-facing alternative to an inline `script`.
 * Run it with:
 *
 *   odw_run({ file: "audit.ts" })          // or tools.odw.run({ file: "audit.ts" })
 *
 * Local files under `workflows/` are *trusted* input (the user wrote them); the
 * sandbox still applies, so this script has no filesystem or network access of
 * its own. Everything it reads is read by a worker session.
 *
 * It demonstrates the whole M3 surface in the order it is normally used:
 *   pipeline  - two stages per item, items in flight bounded by `concurrency`
 *   checkpoint - a durable marker once the raw data is in
 *   verify     - an adversarial read-only check before claiming success
 *   budget     - what the run has cost so far
 */
export default async (ctx) => {
  const files = ["src/index.ts", "src/types.ts", "src/runner/runner.ts"]

  await ctx.phase("audit")
  const notes = await ctx.pipeline(
    files,
    // Stage 1: read one file and produce a structured note about it.
    (input, item) =>
      ctx.agent({
        label: "read:" + item,
        prompt:
          "Read " + item + " in this repository and reply with JSON only: " +
          '{"purpose": string, "exports": string[]}. ' +
          "purpose is one sentence. exports lists the public names it defines.",
        schema: {
          type: "object",
          properties: { purpose: { type: "string" }, exports: { type: "array", items: { type: "string" } } },
          required: ["purpose", "exports"],
        },
      }),
    // Stage 2: summarise the note into the line that ends up in the report.
    (input, item) =>
      ctx.agent({
        label: "summarise:" + item,
        prompt:
          "Rewrite this into one plain line, no JSON, no markdown, at most 120 characters. " +
          "Keep the file name. JSON: " + JSON.stringify({ file: item, note: input }),
      }),
  )

  await ctx.checkpoint("audit-raw", { files, notes, budget: ctx.budget() })

  await ctx.phase("verify")
  const verdict = await ctx.verify({
    claim:
      "Every line in this report corresponds to a real file in the repository, and none of the described " +
      "purposes contradicts the file's actual contents: " + JSON.stringify(notes),
  })

  return {
    lines: notes,
    verified: verdict.pass,
    reasons: verdict.reasons,
    cost: ctx.budget(),
  }
}
