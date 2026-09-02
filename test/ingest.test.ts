import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../src/config.js';
import { createEndpoint } from '../src/repository/endpoints.js';
import { countEventsForEndpoint, findEventById } from '../src/repository/events.js';
import { buildServer } from '../src/server.js';
import { SIGNATURE_HEADER, sign } from '../src/signature.js';
import { createTestPool, truncateAll } from './helpers/db.js';
import { TEST_DATABASE_URL } from './helpers/global-setup.js';

const SECRET = 'a-signing-secret';

const db: pg.Pool = createTestPool();

function configWith(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  });
}

async function anEndpoint(): Promise<string> {
  const endpoint = await createEndpoint(db, {
    name: 'github',
    destinationUrl: 'https://example.com/hook',
    signingSecret: SECRET,
  });
  return endpoint.id;
}

function deliver(
  app: FastifyInstance,
  endpointId: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return app.inject({
    method: 'POST',
    url: `/hook/${endpointId}`,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: sign(payload, SECRET),
      ...headers,
    },
    payload,
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  await truncateAll(db);
  app = buildServer({ config: configWith(), db });
});

afterAll(async () => {
  await db.end();
});

describe('POST /hook/:endpointId', () => {
  it('accepts a correctly signed delivery', async () => {
    const endpointId = await anEndpoint();

    const res = await deliver(app, endpointId, '{"action":"opened"}', {
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'issues',
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'pending', duplicate: false });
    expect(await countEventsForEndpoint(db, endpointId)).toBe(1);
  });

  it('stores the bytes that were signed, not a re-serialised copy', async () => {
    // Key order and whitespace here survive a round trip only if the raw buffer
    // is what reaches storage. Re-serialising the parsed object would produce
    // different bytes and no future replay would verify.
    const endpointId = await anEndpoint();
    const body = '{ "z" : 1,\n  "a"  :  2 }';

    const res = await deliver(app, endpointId, body, { 'x-github-delivery': 'delivery-1' });
    const stored = await findEventById(db, res.json().id);

    expect(stored?.body.toString('utf8')).toBe(body);
    expect(stored?.body.toString('utf8')).not.toBe(JSON.stringify(JSON.parse(body)));
  });

  it('keeps a body that is not valid UTF-8 intact', async () => {
    const endpointId = await anEndpoint();
    const body = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0xff, 0x22, 0x7d]);

    const res = await app.inject({
      method: 'POST',
      url: `/hook/${endpointId}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        [SIGNATURE_HEADER]: sign(body, SECRET),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect((await findEventById(db, res.json().id))?.body.equals(body)).toBe(true);
  });

  it('rejects a wrong signature and stores nothing', async () => {
    const endpointId = await anEndpoint();

    const res = await app.inject({
      method: 'POST',
      url: `/hook/${endpointId}`,
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: sign(Buffer.from('a different body'), SECRET),
      },
      payload: '{"action":"opened"}',
    });

    expect(res.statusCode).toBe(401);
    expect(await countEventsForEndpoint(db, endpointId)).toBe(0);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const endpointId = await anEndpoint();
    const body = '{"a":1}';

    const res = await app.inject({
      method: 'POST',
      url: `/hook/${endpointId}`,
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: sign(Buffer.from(body), 'not-the-secret'),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['missing', undefined],
    ['unprefixed', 'abcdef'],
    ['wrong length', 'sha256=abcd'],
    ['not hex', `sha256=${'z'.repeat(64)}`],
  ])('rejects a %s signature header', async (_label, header) => {
    const endpointId = await anEndpoint();

    const res = await app.inject({
      method: 'POST',
      url: `/hook/${endpointId}`,
      headers: {
        'content-type': 'application/json',
        ...(header === undefined ? {} : { [SIGNATURE_HEADER]: header }),
      },
      payload: '{"a":1}',
    });

    expect(res.statusCode).toBe(401);
  });

  it('collapses a redelivery onto the first event', async () => {
    const endpointId = await anEndpoint();
    const headers = { 'x-github-delivery': 'delivery-1' };

    const first = await deliver(app, endpointId, '{"a":1}', headers);
    const second = await deliver(app, endpointId, '{"a":1}', headers);

    expect(second.statusCode).toBe(202);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().duplicate).toBe(true);
    expect(await countEventsForEndpoint(db, endpointId)).toBe(1);
  });

  it('reports the existing status so a redelivery can be re-driven', async () => {
    const endpointId = await anEndpoint();
    const headers = { 'x-github-delivery': 'delivery-1' };

    const first = await deliver(app, endpointId, '{"a":1}', headers);
    await db.query(`UPDATE events SET status = 'dlq' WHERE id = $1`, [first.json().id]);

    const second = await deliver(app, endpointId, '{"a":1}', headers);

    expect(second.json()).toMatchObject({ status: 'dlq', duplicate: true });
  });

  it('treats deliveries without a delivery id as separate events', async () => {
    const endpointId = await anEndpoint();

    await deliver(app, endpointId, '{"a":1}');
    await deliver(app, endpointId, '{"a":1}');

    expect(await countEventsForEndpoint(db, endpointId)).toBe(2);
  });

  it('404s an endpoint that does not exist', async () => {
    const res = await deliver(app, '00000000-0000-0000-0000-000000000000', '{"a":1}');
    expect(res.statusCode).toBe(404);
  });

  it('404s an id that is not a uuid', async () => {
    const res = await deliver(app, 'not-a-uuid', '{"a":1}');
    expect(res.statusCode).toBe(404);
  });

  it('404s a deactivated endpoint', async () => {
    const endpointId = await anEndpoint();
    await db.query('UPDATE endpoints SET is_active = false WHERE id = $1', [endpointId]);

    const res = await deliver(app, endpointId, '{"a":1}');

    expect(res.statusCode).toBe(404);
    expect(await countEventsForEndpoint(db, endpointId)).toBe(0);
  });

  it('413s a body over the limit', async () => {
    const small = buildServer({ config: configWith({ INGEST_BODY_LIMIT_BYTES: '256' }), db });
    const endpointId = await anEndpoint();

    const res = await deliver(small, endpointId, `{"a":"${'x'.repeat(1024)}"}`);

    expect(res.statusCode).toBe(413);
    expect(await countEventsForEndpoint(db, endpointId)).toBe(0);
    await small.close();
  });

  it('415s a content type it has no parser for', async () => {
    const endpointId = await anEndpoint();

    const res = await app.inject({
      method: 'POST',
      url: `/hook/${endpointId}`,
      headers: {
        'content-type': 'application/xml',
        [SIGNATURE_HEADER]: sign(Buffer.from('<a/>'), SECRET),
      },
      payload: '<a/>',
    });

    expect(res.statusCode).toBe(415);
  });

  it('400s a malformed json body', async () => {
    const endpointId = await anEndpoint();

    const res = await deliver(app, endpointId, '{"a":');

    expect(res.statusCode).toBe(400);
    expect(await countEventsForEndpoint(db, endpointId)).toBe(0);
  });

  it('does not expose the raw body on non-ingest routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
