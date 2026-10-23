import type { ApiResult } from '../shared/api';

/** Main owns the clock; the service applies calendar rules and checkpoints atomically. */
export class ScheduleClock {
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private suspended = false;
  private stopped = false;
  private last?: number;
  constructor(private check: (reason?: 'asleep' | 'app_closed') => Promise<ApiResult<unknown>>,
    private failed: (message: string) => void, private now = Date.now,
    private every = (fn: () => void) => setTimeout(fn, 1000),
    private cancel = clearTimeout) {}

  start() { return this.enqueue('app_closed'); }
  suspend() { this.suspended = true; if (this.timer) this.cancel(this.timer); }
  resume(afterSleep = true) { this.suspended = false; return this.enqueue(afterSleep ? 'asleep' : undefined); }
  stop() { this.stopped = true; if (this.timer) this.cancel(this.timer); }
  private enqueue(reason?: 'asleep' | 'app_closed'): Promise<void> {
    if (this.timer) this.cancel(this.timer);
    this.pending = this.pending.then(async () => {
      if (this.stopped || this.suspended) return;
      if (this.timer) this.cancel(this.timer);
      const now = this.now();
      // A delayed wake notification must never turn a missed alarm into a live run.
      const missed = reason ?? (this.last !== undefined && now - this.last > 5000 ? 'asleep' : undefined);
      const result = await this.check(missed);
      if (!result.ok) throw new Error(result.error.message);
      this.last = now;
      if (!this.stopped && !this.suspended) this.timer = this.every(() => { void this.enqueue(); });
    }).catch((error: unknown) => {
      if (this.stopped) return;
      this.stop();
      this.failed(error instanceof Error ? error.message : 'Schedule clock failed.');
    });
    return this.pending;
  }
}
