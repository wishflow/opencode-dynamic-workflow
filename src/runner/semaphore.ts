/**
 * Counting semaphore with FIFO hand-off.
 *
 * Deliberately tiny and dependency-free. The important property is the release
 * path: when a waiter exists, the slot is transferred directly instead of being
 * decremented and re-acquired, so a limited semaphore can never drop below zero
 * or starve a waiter.
 *
 * Deadlock note: the *worker* semaphore and the *task* limiter used by
 * `ctx.parallel` are two separate instances. If `parallel` acquired the worker
 * semaphore and then its callback called `ctx.agent` - which also acquires it -
 * a run at the concurrency limit would deadlock immediately.
 */
export class Semaphore {
  readonly limit: number
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit < 1) throw new RangeError(`semaphore limit must be >= 1, got ${limit}`)
    this.limit = Math.floor(limit)
  }

  get inFlight(): number {
    return this.active
  }

  get queued(): number {
    return this.waiters.length
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // Hand the slot over without touching `active`.
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
