import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const required = {
  DATABASE_URL: 'postgres://hookrelay:hookrelay@localhost:5432/hookrelay',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('applies defaults when only the required values are present', () => {
    const config = loadConfig(required);

    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('names the missing variable when one is absent', () => {
    expect(() => loadConfig({ REDIS_URL: required.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('coerces PORT from a string and rejects a non-numeric one', () => {
    expect(loadConfig({ ...required, PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadConfig({ ...required, PORT: 'http' })).toThrow(/PORT/);
  });

  it('rejects a log level outside the supported set', () => {
    expect(() => loadConfig({ ...required, LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/);
  });

  it('refuses a pool too small for the worker', () => {
    // A connection timeout is recorded as a failed delivery, so an undersized
    // pool dead-letters events that were never actually attempted.
    expect(() =>
      loadConfig({ ...required, WORKER_CONCURRENCY: '20', DB_POOL_MAX: '10' }),
    ).toThrow(/DB_POOL_MAX/);

    expect(() =>
      loadConfig({ ...required, WORKER_CONCURRENCY: '10', DB_POOL_MAX: '10' }),
    ).toThrow(/must exceed/);

    expect(loadConfig(required).DB_POOL_MAX).toBeGreaterThan(
      loadConfig(required).WORKER_CONCURRENCY,
    );
  });

  it('keeps the outbound address guard on unless it is turned off by name', () => {
    expect(loadConfig(required).ALLOW_PRIVATE_DESTINATIONS).toBe(false);
    expect(
      loadConfig({ ...required, ALLOW_PRIVATE_DESTINATIONS: 'true' }).ALLOW_PRIVATE_DESTINATIONS,
    ).toBe(true);
    // Anything other than the two literals is a typo, and a typo must not
    // silently disable a security control.
    expect(() => loadConfig({ ...required, ALLOW_PRIVATE_DESTINATIONS: 'yes' })).toThrow(
      /ALLOW_PRIVATE_DESTINATIONS/,
    );
  });
});
