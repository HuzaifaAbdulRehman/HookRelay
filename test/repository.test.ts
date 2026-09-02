import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createEndpoint, findEndpointById, listEndpoints } from '../src/repository/endpoints.js';
import { countEventsForEndpoint, findEventById, recordEvent } from '../src/repository/events.js';
import { createTestPool, truncateAll } from './helpers/db.js';

const db: pg.Pool = createTestPool();

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

function anEndpointInput(name = 'github') {
  return {
    name,
    destinationUrl: 'https://example.com/hook',
    signingSecret: 'shhh',
  };
}

describe('endpoints repository', () => {
  it('round-trips an endpoint', async () => {
    const created = await createEndpoint(db, anEndpointInput());

    const found = await findEndpointById(db, created.id);

    expect(found).toEqual(created);
    expect(created.isActive).toBe(true);
  });

  it('returns null for an id that does not exist', async () => {
    const found = await findEndpointById(db, '00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });

  it('lists newest first', async () => {
    const first = await createEndpoint(db, anEndpointInput('first'));
    const second = await createEndpoint(db, anEndpointInput('second'));

    const names = (await listEndpoints(db)).map((e) => e.name);

    expect(names).toEqual(['second', 'first']);
    expect(first.id).not.toBe(second.id);
  });
});

describe('recordEvent', () => {
  it('records a new event as inserted and pending', async () => {
    const endpoint = await createEndpoint(db, anEndpointInput());

    const result = await recordEvent(db, {
      endpointId: endpoint.id,
      providerEventId: 'delivery-1',
      headers: { 'x-github-event': 'push' },
      body: Buffer.from('{"ok":true}'),
    });

    expect(result.inserted).toBe(true);
    expect(result.status).toBe('pending');
  });

  it('collapses a redelivery onto the original row', async () => {
    const endpoint = await createEndpoint(db, anEndpointInput());
    const input = {
      endpointId: endpoint.id,
      providerEventId: 'delivery-1',
      headers: {},
      body: Buffer.from('first'),
    };

    const first = await recordEvent(db, input);
    const second = await recordEvent(db, { ...input, body: Buffer.from('second') });

    expect(second.id).toBe(first.id);
    expect(second.inserted).toBe(false);
    expect(await countEventsForEndpoint(db, endpoint.id)).toBe(1);

    // The original payload wins. A redelivery carries the same event, and
    // overwriting would invalidate a signature computed over the first body.
    const stored = await findEventById(db, first.id);
    expect(stored?.body.toString()).toBe('first');
  });

  it('returns the existing status so a redelivery can be re-driven', async () => {
    const endpoint = await createEndpoint(db, anEndpointInput());
    const input = {
      endpointId: endpoint.id,
      providerEventId: 'delivery-1',
      headers: {},
      body: Buffer.from('x'),
    };

    const first = await recordEvent(db, input);
    await db.query(`UPDATE events SET status = 'dlq' WHERE id = $1`, [first.id]);

    const second = await recordEvent(db, input);

    expect(second.status).toBe('dlq');
  });

  it('treats every keyless event as distinct', async () => {
    // The arbiter index is partial, so rows with a null provider id never enter
    // it. This is the behaviour the Postgres docs do not spell out, so it is
    // asserted rather than assumed.
    const endpoint = await createEndpoint(db, anEndpointInput());
    const input = {
      endpointId: endpoint.id,
      providerEventId: null,
      headers: {},
      body: Buffer.from('x'),
    };

    const first = await recordEvent(db, input);
    const second = await recordEvent(db, input);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(await countEventsForEndpoint(db, endpoint.id)).toBe(2);
  });

  it('keeps the same provider id separate across endpoints', async () => {
    const a = await createEndpoint(db, anEndpointInput('a'));
    const b = await createEndpoint(db, anEndpointInput('b'));

    const first = await recordEvent(db, {
      endpointId: a.id,
      providerEventId: 'shared',
      headers: {},
      body: Buffer.from('x'),
    });
    const second = await recordEvent(db, {
      endpointId: b.id,
      providerEventId: 'shared',
      headers: {},
      body: Buffer.from('x'),
    });

    expect(second.id).not.toBe(first.id);
    expect(second.inserted).toBe(true);
  });

  it('stores the body byte-for-byte', async () => {
    // Signature verification hashes the exact bytes received, so anything that
    // re-encodes the payload on the way to storage breaks replay.
    const endpoint = await createEndpoint(db, anEndpointInput());
    const body = Buffer.from([0x7b, 0xe9, 0x00, 0xff, 0xc3, 0x28, 0x7d]);

    const { id } = await recordEvent(db, {
      endpointId: endpoint.id,
      providerEventId: 'bytes',
      headers: {},
      body,
    });

    const stored = await findEventById(db, id);

    expect(stored?.body).toBeInstanceOf(Buffer);
    expect(stored?.body.equals(body)).toBe(true);
  });

  it('preserves header casing and values', async () => {
    const endpoint = await createEndpoint(db, anEndpointInput());
    const headers = { 'X-GitHub-Delivery': 'abc', 'content-type': 'application/json' };

    const { id } = await recordEvent(db, {
      endpointId: endpoint.id,
      providerEventId: 'headers',
      headers,
      body: Buffer.from('{}'),
    });

    expect((await findEventById(db, id))?.headers).toEqual(headers);
  });
});
