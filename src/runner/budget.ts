import { addTokens, zeroTokens, type BudgetSnapshot, type Tokens, type WorkerUsage } from "../types.ts"

/**
 * Run-scoped accounting.
 *
 * `cache.read` is counted on purpose: it shows up non-zero on every real
 * round-trip (measured, PLAN §1 C6) and it is billed, so a budget that only sums
 * `input` would silently under-report.
 *
 * The limit is checked *before* dispatching a worker, not after: the point is to
 * stop spending, and a worker that already ran cannot be un-billed.
 */
export class Budget {
  readonly limitUsd: number | null
  private tokens: Tokens = zeroTokens()
  private costUsd = 0
  private workerCount = 0

  constructor(limitUsd?: number) {
    this.limitUsd = typeof limitUsd === "number" && limitUsd > 0 ? limitUsd : null
  }

  get workers(): number {
    return this.workerCount
  }

  get cost(): number {
    return this.costUsd
  }

  get totals(): Tokens {
    return { ...this.tokens }
  }

  /** Called once per settled worker (success *and* failure - a failed turn still bills). */
  record(usage: WorkerUsage): void {
    this.workerCount += 1
    this.costUsd += usage.cost
    this.tokens = addTokens(this.tokens, usage.tokens)
  }

  exceeded(): boolean {
    return this.limitUsd !== null && this.costUsd > this.limitUsd
  }

  describeLimit(): string {
    if (this.limitUsd === null) return "no budget limit"
    return `budgetUsd=${this.limitUsd}, spent $${this.costUsd.toFixed(4)}`
  }

  snapshot(): BudgetSnapshot {
    return {
      workers: this.workerCount,
      cost: this.costUsd,
      tokens: { ...this.tokens },
      limitUsd: this.limitUsd,
    }
  }
}
