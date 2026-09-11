import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { escape, html, ladder } from '../src/dashboard/html.js';
import { claimForDelivery, recordAttempt } from '../src/repository/attempts.js';
import { createEndpoint } from '../src/repository/endpoints.js';
import { recordEvent } from '../src/repository/events.js';
import { buildServer } from '../src/server.js';
import { createTestPool, truncateAll } from './helpers/db.js';
import { TEST_DATABASE_URL } from './helpers/global-setup.js';

const API_KEY = 'a-sufficiently-long-management-key';
const db: pg.Pool = createTestPool();

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: 'redis://localhost:6379',
  API_KEY,
});

const basic = { authorization: `Basic ${Buffer.from(`admin:${API_KEY}`).toString('base64')}` };
const bearer = { authorization: `Bearer ${API_KEY}` };

let app: FastifyInstance;
let replayed: { eventId: string; attempt: number }[] = [];

beforeEach(async () => {
  await truncateAll(db);
  replayed = [];
  app = buildServer({
    config,
    db,
    onReplayed: async (eventId, attempt) => {
      replayed.push({ eventId, attempt });
    },
  });
});

afterAll(async () => {
  await db.end();
});

describe('escaping', () => {
  it('neutralises markup in an interpolation', () => {
    const evil = '<script>alert(1)</script>';
    expect(html`<td>${evil}</td>`).toBe('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>');
    expect(escape(`" onload="x`)).toBe('&quot; onload=&quot;x');
  });
});

describe('the retry ladder', () => {
  it('draws one rung per attempt and names the shape in text', () => {
    const marks = ladder([
      { attemptNumber: 1, status: 'failed' },
      { attemptNumber: 2, status: 'failed' },
      { attemptNumber: 3, status: 'delivered' },
    ]);

    expect(marks.match(/class="rung /g)).toHaveLength(3);
    expect(marks).toContain('rung-delivered');
    // Colour is never the only channel: the count is stated and the group has
    // an accessible name.
    expect(marks).toContain('3 attempts, 2 failed');
    expect(marks).toContain('aria-label');
  });

  it('renders nothing when there is nothing to show', () => {
    expect(ladder([])).toBe('');
  });

  it('escapes a status it did not choose', () => {
    expect(ladder([{ attemptNumber: 1, status: '"><script>' }])).not.toContain('<script>');
  });
});

describe('the dashboard', () => {
  it('asks for credentials rather than showing anything', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('rejects the wrong password', async () => {
    const wrong = { authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` };

    expect((await app.inject({ method: 'GET', url: '/dashboard', headers: wrong })).statusCode).toBe(
      401,
    );
  });

  it('renders an overview without exposing its ingest capability', async () => {
    const endpoint = await createEndpoint(db, {
      name: 'github-prod',
      destinationUrl: 'https://example.com/hook',
      signingSecret: 'secret',
    });

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: basic });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('github-prod');
    expect(res.body).toContain('/hook/••••••••');
    expect(res.body).not.toContain(`/hook/${endpoint.id}`);
  });

  it('never renders a signing secret', async () => {
    await createEndpoint(db, {
      name: 'github',
      destinationUrl: 'https://example.com/hook',
      signingSecret: 'super-secret-value',
    });

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: basic });

    expect(res.body).not.toContain('super-secret-value');
  });

  it('escapes what a destination sent back', async () => {
    // The response snippet comes from whatever server the destination points
    // at, so rendering it raw would let a destination store script here.
    const endpoint = await createEndpoint(db, {
      name: 'x',
      destinationUrl: 'https://example.com/h',
      signingSecret: 's',
    });
    const event = await recordEvent(db, {
      endpointId: endpoint.id,
      providerEventId: '<img src=x onerror=alert(1)>',
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
        status: 'failed',
        responseStatus: 500,
        responseSnippet: null,
        error: '<script>alert("stored")</script>',
        durationMs: 100,
      },
      { kind: 'dead' },
    );

    const res = await app.inject({
      method: 'GET',
      url: `/dashboard/events/${event.id}`,
      headers: basic,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>alert');
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('offers replay on a dead-lettered event and fires it', async () => {
    const endpoint = await createEndpoint(db, {
      name: 'x',
      destinationUrl: 'https://example.com/h',
      signingSecret: 's',
    });
    const event = await recordEvent(db, {
      endpointId: endpoint.id,
      providerEventId: 'd1',
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
        status: 'failed',
        responseStatus: 503,
        responseSnippet: 'nope',
        error: null,
        durationMs: 0,
      },
      { kind: 'dead' },
    );

    const page = await app.inject({
      method: 'GET',
      url: `/dashboard/events/${event.id}`,
      headers: basic,
    });
    expect(page.body).toContain('Replay this event');

    const posted = await app.inject({
      method: 'POST',
      url: `/dashboard/events/${event.id}/replay`,
      headers: { ...basic, host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'replay=1',
    });

    expect(posted.statusCode).toBe(303);
    expect(replayed).toEqual([{ eventId: event.id, attempt: 2 }]);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['no origin at all', undefined],
  ])('refuses a replay posted from %s', async (_label, origin) => {
    // Browsers attach Basic credentials to a cross-site form post the same way
    // they attach cookies, so authentication alone does not make this safe.
    const endpoint = await createEndpoint(db, {
      name: 'x',
      destinationUrl: 'https://example.com/h',
      signingSecret: 's',
    });
    const event = await recordEvent(db, {
      endpointId: endpoint.id,
      providerEventId: 'd1',
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
        status: 'failed',
        responseStatus: 503,
        responseSnippet: null,
        error: null,
        durationMs: 0,
      },
      { kind: 'dead' },
    );

    const res = await app.inject({
      method: 'POST',
      url: `/dashboard/events/${event.id}/replay`,
      headers: {
        ...basic,
        host: 'localhost:3000',
        ...(origin === undefined ? {} : { origin }),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(replayed).toHaveLength(0);
  });
});

describe('the endpoints api', () => {
  it('creates an endpoint and returns the secret exactly once', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/endpoints',
      headers: bearer,
      payload: { name: 'github', destinationUrl: 'https://example.com/hook' },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.signingSecret).toHaveLength(43);
    expect(body.ingestPath).toBe(`/hook/${body.id}`);

    const read = await app.inject({ method: 'GET', url: `/endpoints/${body.id}`, headers: bearer });
    expect(read.json()).not.toHaveProperty('signingSecret');
    expect(read.body).not.toContain(body.signingSecret);
  });

  it('rejects a nameless endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/endpoints',
      headers: bearer,
      payload: { name: '   ', destinationUrl: 'https://example.com/hook' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('needs the key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/endpoints',
      payload: { name: 'x', destinationUrl: 'https://example.com/h' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('deactivates rather than deletes, keeping the history', async () => {
    const endpoint = await createEndpoint(db, {
      name: 'x',
      destinationUrl: 'https://example.com/h',
      signingSecret: 's',
    });
    await recordEvent(db, {
      endpointId: endpoint.id,
      providerEventId: 'd1',
      headers: {},
      body: Buffer.from('{}'),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/endpoints/${endpoint.id}`,
      headers: bearer,
    });

    expect(res.statusCode).toBe(200);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM events');
    expect(rows[0].n).toBe(1);
  });
});
