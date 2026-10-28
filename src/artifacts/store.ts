import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Run artifacts on disk: `script.ts`, `meta.json`, `journal.jsonl`, `result.json`
 * and anything a future primitive wants to persist.
 *
 * Worker sessions are *not* deleted when a run finishes - their transcripts are
 * the primary evidence for what happened, and `parentID` makes them collapsible
 * in the session tree. These files are the machine-readable half of the same
 * record.
 */
export type RunArtifacts = {
  readonly dir: string
  readonly runId: string
  write(name: string, content: string): string
  writeJson(name: string, value: unknown): string
}

export function createRunArtifacts(root: string, runId: string): RunArtifacts {
  const dir = join(root, runId)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    runId,
    write(name, content) {
      const path = join(dir, name)
      // Names may carry a subdirectory (`checkpoints/001-x.json`), so the parent
      // is created on demand rather than requiring every caller to pre-declare a
      // layout.
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return path
    },
    writeJson(name, value) {
      return this.write(name, `${JSON.stringify(value, null, 2)}\n`)
    },
  }
}

export function defaultArtifactsRoot(projectDirectory: string): string {
  return join(projectDirectory, ".odw", "runs")
}

/**
 * Keeps the artifacts root bounded. Workers are never pruned; only the oldest
 * run *directories* are, oldest first by name (run ids are timestamp-prefixed).
 */
export function pruneRuns(root: string, keep: number): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  const doomed = entries.slice(0, Math.max(0, entries.length - keep))
  for (const name of doomed) {
    try {
      rmSync(join(root, name), { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
  return doomed
}
