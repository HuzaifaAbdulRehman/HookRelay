import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  backoffMs,
  isExhausted,
  isRetryableStatus,
} from '../src/delivery/policy.js';

describe('backoffMs', () => {
  it('doubles the base delay each attempt', () => {
    const mid = () => 0.5;
    // half + half*0.5 = 0.75 of the exponential
    expect(backoffMs(1, DEFAULT_POLICY, mid)).toBe(750);
    expect(backoffMs(2, DEFAULT_POLICY, mid)).toBe(1_500);
    expect(backoffMs(3, DEFAULT_POLICY, mid)).toBe(3_000);
  });

  it('never returns less than half the exponential', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const exponential = Math.min(DEFAULT_POLICY.capMs, DEFAULT_POLICY.baseMs * 2 ** (attempt - 1));
      expect(backoffMs(attempt, DEFAULT_POLICY, () => 0)).toBe(exponential / 2);
      expect(backoffMs(attempt, DEFAULT_POLICY, () => 0.999999)).toBeLessThan(exponential);
    }
  });

  it('holds at the cap instead of growing without bound', () => {
    const late = backoffMs(40, DEFAULT_POLICY, () => 0.999999);
    expect(late).toBeLessThan(DEFAULT_POLICY.capMs);
    expect(late).toBeGreaterThanOrEqual(DEFAULT_POLICY.capMs / 2);
  });

  it('spreads successive delays rather than phase-locking them', () => {
    const delays = new Set(Array.from({ length: 200 }, () => backoffMs(5)));
    expect(delays.size).toBeGreaterThan(100);
  });

  it('rejects an attempt number below one', () => {
    expect(() => backoffMs(0)).toThrow(RangeError);
  });
});

describe('isExhausted', () => {
  it('is false until the last attempt has been made', () => {
    expect(isExhausted(7)).toBe(false);
    expect(isExhausted(8)).toBe(true);
    expect(isExhausted(9)).toBe(true);
  });
});

describe('isRetryableStatus', () => {
  it.each([500, 502, 503, 504, 408, 429])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 410, 422])('does not retry %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });

  it.each([200, 201, 202, 204])('treats %i as delivered', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});
