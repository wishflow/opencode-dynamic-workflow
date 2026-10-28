import { appendFileSync } from "node:fs"

/**
 * Append-only run journal (`journal.jsonl`).
 *
 * Synchronous writes are intentional: events are small, the runner is single
 * process, and ordering matters more than throughput. A run that dies - timeout,
 * abort, OOM - must still leave a readable trail up to the last completed step,
 * which a buffered stream would not guarantee.
 */
export class Journal {
  private seq = 0

  constructor(private readonly file: string) {}

  append(event: Record<string, unknown> & { type: string }): void {
    this.seq += 1
    const line = JSON.stringify({ seq: this.seq, at: new Date().toISOString(), ...event })
    try {
      appendFileSync(this.file, `${line}\n`)
    } catch {
      // Journaling is diagnostics, never a reason to fail a run.
    }
  }
}
