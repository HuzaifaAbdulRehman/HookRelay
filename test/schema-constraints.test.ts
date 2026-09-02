import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, truncateAll } from './helpers/db.js';

const db: pg.Pool = createTestPool();

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function anEndpoint(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO endpoints (name, destination_url, signing_secret)
     VALUES ('test', 'https://example.com/hook', 'secret') RETURNING id`,
  );
  return rows[0]!.id;
}

async function anEvent(endpointId: string, providerEventId: string | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO events (endpoint_id, provider_event_id, headers, body)
     VALUES ($1, $2, '{}'::jsonb, '\\x00'::bytea) RETURNING id`,
    [endpointId, providerEventId],
  );
  return rows[0]!.id;
}

describe('endpoints constraints', () => {
  it('rejects a blank name', async () => {
    await expect(
      db.query(
        `INSERT INTO endpoints (name, destination_url, signing_secret)
         VALUES ('   ', 'https://example.com', 's')`,
      ),
    ).rejects.toMatchObject({ constraint: 'endpoints_name_not_blank' });
  });
});

describe('events constraints', () => {
  it('rejects a status outside the allowed set', async () => {
    const endpointId = await anEndpoint();
    await expect(
      db.query(
        `INSERT INTO events (endpoint_id, headers, body, status)
         VALUES ($1, '{}'::jsonb, '\\x00'::bytea, 'in_flight')`,
        [endpointId],
      ),
    ).rejects.toMatchObject({ constraint: 'events_status_check' });
  });

  it('rejects a negative attempt count', async () => {
    const endpointId = await anEndpoint();
    await expect(
      db.query(
        `INSERT INTO events (endpoint_id, headers, body, attempt_count)
         VALUES ($1, '{}'::jsonb, '\\x00'::bytea, -1)`,
        [endpointId],
      ),
    ).rejects.toMatchObject({ constraint: 'events_attempt_count_non_negative' });
  });

  it('rejects an event whose endpoint does not exist', async () => {
    await expect(
      db.query(
        `INSERT INTO events (endpoint_id, headers, body)
         VALUES ('00000000-0000-0000-0000-000000000000', '{}'::jsonb, '\\x00'::bytea)`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a repeated provider id on the same endpoint', async () => {
    const endpointId = await anEndpoint();
    await anEvent(endpointId, 'delivery-1');

    await expect(anEvent(endpointId, 'delivery-1')).rejects.toMatchObject({ code: '23505' });
  });

  it('allows the same provider id on a different endpoint', async () => {
    const first = await anEndpoint();
    const second = await anEndpoint();

    await anEvent(first, 'delivery-1');

    await expect(anEvent(second, 'delivery-1')).resolves.toBeTypeOf('string');
  });

  it('deletes an endpoint together with its events', async () => {
    const endpointId = await anEndpoint();
    await anEvent(endpointId, 'delivery-1');

    await db.query('DELETE FROM endpoints WHERE id = $1', [endpointId]);

    const { rows } = await db.query<{ count: string }>('SELECT count(*)::text FROM events');
    expect(rows[0]!.count).toBe('0');
  });
});

describe('delivery_attempts constraints', () => {
  it('rejects a repeated attempt number for one event', async () => {
    const eventId = await anEvent(await anEndpoint());
    await db.query(
      `INSERT INTO delivery_attempts (event_id, attempt_number, status)
       VALUES ($1, 1, 'failed')`,
      [eventId],
    );

    await expect(
      db.query(
        `INSERT INTO delivery_attempts (event_id, attempt_number, status)
         VALUES ($1, 1, 'delivered')`,
        [eventId],
      ),
    ).rejects.toMatchObject({ constraint: 'delivery_attempts_event_attempt_key' });
  });

  it('rejects attempt number zero', async () => {
    const eventId = await anEvent(await anEndpoint());

    await expect(
      db.query(
        `INSERT INTO delivery_attempts (event_id, attempt_number, status)
         VALUES ($1, 0, 'failed')`,
        [eventId],
      ),
    ).rejects.toMatchObject({ constraint: 'delivery_attempts_attempt_number_positive' });
  });

  it('rejects a status outside the allowed set', async () => {
    const eventId = await anEvent(await anEndpoint());

    await expect(
      db.query(
        `INSERT INTO delivery_attempts (event_id, attempt_number, status)
         VALUES ($1, 1, 'maybe')`,
        [eventId],
      ),
    ).rejects.toMatchObject({ constraint: 'delivery_attempts_status_check' });
  });
});
