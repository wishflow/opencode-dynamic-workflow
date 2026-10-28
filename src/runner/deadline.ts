import { WorkflowTimeoutError } from "../types.ts"

/**
 * The async half of the capability fence.
 *
 * `vm`'s watchdog only stops synchronous execution; a script parked on an
 * `await` (or on a primitive that never settles) is invisible to it. So the wall
 * clock is enforced cooperatively: every primitive checks the deadline before it
 * runs, and the runner additionally races the whole script against a timer.
 */
export class Deadline {
  private readonly expiresAt: number

  constructor(expiresAt: number) {
    this.expiresAt = expiresAt
  }

  static after(ms: number): Deadline {
    return new Deadline(Date.now() + ms)
  }

  get at(): number {
    return this.expiresAt
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now())
  }

  expired(): boolean {
    return Date.now() >= this.expiresAt
  }

  check(what: string): void {
    if (this.expired()) {
      throw new WorkflowTimeoutError(`${what} 之前已超时：脚本 wall-clock 预算已用完（${what} 未开始或未完成）`)
    }
  }
}
