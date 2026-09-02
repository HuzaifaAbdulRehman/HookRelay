import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../src/config.js';
import { claimForDelivery, recordAttempt } from '../src/repository/attempts.js';
import { createEndpoint } from '../src/repository/endpoints.js';
import { recordEvent } from '../src/repository/events.js';
import { buildServer } from '../src/server.js';
import { createTestPool, truncateAll } from './helpers/db.js';
import { TEST_DATABASE_URL } from './helpers/global-setup.js';

const API_KEY = 'a-sufficiently-long-management-key';
const db: pg.Pool = createTestPool();

function configWith(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: 'redis://localhost:6379',
    API_KEY,
    ...overrides,
  });
}

let app: FastifyInstance;
let replayed: { eventId: string; attempt: number }[] = [];

beforeEach(async () => {
  await truncateAll(db);
  replayed = [];
  app = buildServer({
    config: configWith(),
    db,
    onReplayed: async (eventId, attempt) => {
      replayed.push({ eventId, attempt });
    },
  });
});

afterAll(async () => {
  await db.end();
});

const auth = { authorization: `Bearer ${API_KEY}` };

async function aDeadEvent(): Promise<string> {
  const endpoint = await createEndpoint(db, {
    name: 'github',
    destinationUrl: 'https://example.com/hook',
    signingSecret: 'secret',
  });
  const event = await recordEvent(db, {
    endpointId: endpoint.id,
    providerEventId: 'd1',
    headers: {},
    body: Buffer.from('{"a":1}'),
  });
  const claim = await claimForDelivery(db, event.id);
  await recordAttempt(
    db,
    {
      eventId: event.id,
      attemptNumber: claim!.attemptNumber,
      ladderPosition: claim!.ladderPosition,
      status: 'failed',
      responseStatus: 503,
      responseSnippet: 'unavailable',
      error: null,
      durationMs: 100,
    },
    { kind: 'dead' },
  );
  return event.id;
}

describe('authentication', () => {
  it.each([
    ['no header', undefined],
    ['not a bearer token', 'Basic abc'],
    ['the wrong key', 'Bearer wrong-key-of-the-right-sort'],
    ['a prefix of the key', `Bearer ${API_KEY.slice(0, 10)}`],
  ])('rejects a request with %s', async (_label, header) => {
    const eventId = await aDeadEvent();

    const res = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/replay`,
      ...(header === undefined ? {} : { headers: { authorization: header } }),
    });

    expect(res.statusCode).toBe(401);
    expect(replayed).toHaveLength(0);
  });

  it('does not register the routes at all without a key', async () => {
    // A default key would be worse than none, so the absence of one removes the
    // surface rather than protecting it badly.
    const noKey = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: 'redis://localhost:6379',
    });
    const bare = buildServer({ config: noKey, db });
    const eventId = await aDeadEvent();

    const res = await bare.inject({
      method: 'POST',
      url: `/events/${eventId}/replay`,
      headers: auth,
    });

    expect(res.statusCode).toBe(404);
    await bare.close();
  });

  it('refuses to boot on a blank or short key rather than treating it as absent', () => {
    // Silently disabling auth on a typo is the failure mode worth preventing.
    expect(() => configWith({ API_KEY: '' })).toThrow(/API_KEY/);
    expect(() => configWith({ API_KEY: 'short' })).toThrow(/API_KEY/);
  });
});

describe('GET /events/:id', () => {
  it('returns the event with its delivery log', async () => {
    const eventId = await aDeadEvent();

    const res = await app.inject({ method: 'GET', url: `/events/${eventId}`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: eventId, status: 'dlq', attemptCount: 1 });
    expect(res.json().attempts).toHaveLength(1);
  });

  it('does not hand back the payload', async () => {
    const eventId = await aDeadEvent();

    const res = await app.inject({ method: 'GET', url: `/events/${eventId}`, headers: auth });

    expect(res.json()).not.toHaveProperty('body');
    expect(res.body).not.toContain('{"a":1}');
  });

  it('404s an unknown id and a malformed one alike', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', 'nonsense']) {
      const res = await app.inject({ method: 'GET', url: `/events/${id}`, headers: auth });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('POST /events/:id/replay', () => {
  it('requeues a dead-lettered event after the attempts already recorded', async () => {
    const eventId = await aDeadEvent();

    const res = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/replay`,
      headers: auth,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'pending' });
    expect(replayed).toEqual([{ eventId, attempt: 2 }]);
  });

  it('409s an event that is not replayable', async () => {
    const endpoint = await createEndpoint(db, {
      name: 'x',
      destinationUrl: 'https://example.com/h',
      signingSecret: 's',
    });
    const event = await recordEvent(db, {
      endpointId: endpoint.id,
      providerEventId: 'd2',
      headers: {},
      body: Buffer.from('{}'),
    });
    const claim = await claimForDelivery(db, event.id);
    await recordAttempt(
      db,
      {
        eventId: event.id,
        attemptNumber: claim!.attemptNumber,
        ladderPosition: claim!.ladderPosition,
        status: 'delivered',
        responseStatus: 200,
        responseSnippet: 'ok',
        error: null,
        durationMs: 0,
      },
      { kind: 'delivered' },
    );

    const res = await app.inject({
      method: 'POST',
      url: `/events/${event.id}/replay`,
      headers: auth,
    });

    expect(res.statusCode).toBe(409);
    expect(replayed).toHaveLength(0);
  });
});
