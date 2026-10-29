import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/**
 * The shipped skill is the plugin's *only* natural-language trigger: the
 * `description` is what the model reads before loading anything, and the body is
 * the whole how-to. Neither is enforced by a type system, so the two properties a
 * broken skill violates (a name that does not match its directory, an empty or
 * oversized description) are pinned here.
 *
 * Spec: `name` matches the parent directory, lowercase with hyphens; `description`
 * is non-empty and well under the 1024-character limit.
 */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills")

describe("skills/odw/SKILL.md", () => {
  const dir = "odw"
  const raw = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8")
  const { frontmatter, body } = splitFrontmatter(raw)

  it("is the only skill shipped, and lives in its own directory", () => {
    expect(readdirSync(SKILLS_DIR)).toEqual([dir])
  })

  it("opens with a frontmatter block", () => {
    expect(frontmatter).not.toBeNull()
  })

  it("names itself after its directory, lowercase with hyphens", () => {
    expect(field(frontmatter ?? "", "name")).toBe(dir)
    expect(dir).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it("carries a non-empty description well under the 1024-character limit", () => {
    const description = field(frontmatter ?? "", "description")
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThan(1024)
  })

  it("states when NOT to use the plugin, since that only works before activation", () => {
    const description = field(frontmatter ?? "", "description")
    expect(description).toContain("不用")
  })

  it("has a body that stays inside the spec's size budget", () => {
    const lines = body.trim().split("\n")
    expect(lines.length).toBeGreaterThan(20)
    expect(lines.length).toBeLessThan(500)
  })
})

/** Splits `---\n...\n---\nbody` without pulling in a YAML parser. */
function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  return match === null ? { frontmatter: null, body: source } : { frontmatter: match[1] ?? "", body: match[2] ?? "" }
}

/** Reads a flat `key: value` frontmatter field. */
function field(frontmatter: string, key: string): string {
  for (const line of frontmatter.split("\n")) {
    if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim()
  }
  return ""
}
