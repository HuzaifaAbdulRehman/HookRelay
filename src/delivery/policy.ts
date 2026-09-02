export interface RetryPolicy {
  /** Total delivery attempts before an event is dead-lettered. */
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 8,
  baseMs: 1_000,
  capMs: 60 * 60 * 1_000,
};

/**
 * Equal jitter: half the exponential delay, plus a random share of the other half.
 *
 * Un-jittered backoff phase-locks every failing delivery into the same retry
 * instant, so a destination that comes back up is hit by the whole backlog at
 * once. Full jitter spreads better but can return a near-zero delay, which
 * hammers a service that has just told us it is struggling. Keeping half the
 * delay fixed buys the spread without losing the backoff.
 */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_POLICY,
  random: () => number = Math.random,
): number {
  if (attempt < 1) throw new RangeError(`attempt must be >= 1, got ${attempt}`);

  const exponential = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  const half = exponential / 2;

  return Math.floor(half + random() * half);
}

export function isExhausted(attempt: number, policy: RetryPolicy = DEFAULT_POLICY): boolean {
  return attempt >= policy.maxAttempts;
}

/**
 * 4xx other than 408 and 429 will fail the same way on every retry, so retrying
 * one only burns the ladder and the destination's error budget.
 */
export function isRetryableStatus(status: number): boolean {
  if (status >= 200 && status < 300) return false;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}
