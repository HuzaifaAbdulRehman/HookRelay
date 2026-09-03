export interface CircuitOptions {
  /** Consecutive failures before the circuit opens. */
  threshold?: number;
  /** How long it stays open before one probe is allowed through. */
  openMs?: number;
}

interface State {
  failures: number;
  openedAt: number;
}

/**
 * Stops a dead destination from holding worker slots.
 *
 * A destination that accepts a connection and never answers occupies a slot for
 * the whole delivery timeout. Enough of those and every slot is held, so an
 * unrelated endpoint waits behind them. Once a destination has failed
 * repeatedly there is no information left in trying again immediately, so the
 * job is rescheduled without the call and the slot is freed in microseconds
 * rather than seconds.
 *
 * Per process rather than shared. Two workers each learn about a dead
 * destination separately, which costs one extra timeout per worker and avoids
 * putting a coordination dependency in the delivery path.
 */
export class Circuit {
  private readonly states = new Map<string, State>();
  private readonly threshold: number;
  private readonly openMs: number;

  constructor(options: CircuitOptions = {}, private readonly now: () => number = Date.now) {
    this.threshold = options.threshold ?? 5;
    this.openMs = options.openMs ?? 30_000;
  }

  /** True when the destination should not be dialled at all right now. */
  isOpen(key: string): boolean {
    const state = this.states.get(key);
    if (state === undefined || state.failures < this.threshold) return false;

    if (this.now() - state.openedAt >= this.openMs) {
      // Let exactly one delivery through to find out whether it recovered.
      state.failures = this.threshold - 1;
      return false;
    }

    return true;
  }

  recordFailure(key: string): void {
    const state = this.states.get(key) ?? { failures: 0, openedAt: 0 };
    state.failures += 1;
    if (state.failures >= this.threshold) state.openedAt = this.now();
    this.states.set(key, state);
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  /** Test and diagnostic view. */
  failures(key: string): number {
    return this.states.get(key)?.failures ?? 0;
  }
}
