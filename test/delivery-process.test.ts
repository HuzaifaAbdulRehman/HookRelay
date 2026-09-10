import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Queue } from 'bullmq';
import type pg from 'pg';
import { Agent } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Circuit } from '../src/delivery/circuit.js';
import { processDelivery } from '../src/delivery/process.js';
import type { DeliveryJobData } from '../src/delivery/queue.js';
import { listAttempts } from '../src/repository/attempts.js';
import { createEndpoint } from '../src/repository/endpoints.js';
import { findEventById, recordEvent } from '../src/repository/events.js';
import { verifySignature } from '../src/signature.js';
import { createTestPool, truncateAll } from './helpers/db.js';

const SECRET = 'delivery-secret';
const BODY = Buffer.from('{"hello":"world"}');

const db: pg.Pool = createTestPool();
const agent = new Agent();

let server: Server;
let port: number;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let received: {
  body: string;
  signature: string;
  idempotencyKey: string;
  attempt: string;
  githubEvent: string;
  arbitraryHeader: string;
}[] = [];

/** Records what was enqueued instead of talking to Redis; scheduling is what matters here. */
function fakeQueue() {
  const added: { data: DeliveryJobData; delay: number; jobId: string }[] = [];
  return {
    added,
    queue: {
      add: async (
        _name: string,
        data: DeliveryJobData,
        opts: { delay?: number; jobId: string },
      ) => {
        added.push({ data, delay: opts.delay ?? 0, jobId: opts.jobId });
      },
    } as unknown as Queue<DeliveryJobData>,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString(),
        signature: String(req.headers['x-hub-signature-256'] ?? ''),
        idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
        attempt: String(req.headers['x-hookrelay-attempt'] ?? ''),
        githubEvent: String(req.headers['x-github-event'] ?? ''),
        arbitraryHeader: String(req.headers['x-arbitrary-header'] ?? ''),
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await agent.close();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
  received = [];
  handler = (_req, res) => res.writeHead(200).end('ok');
});

async function anEvent(headers: Record<string, string> = {}): Promise<string> {
  const endpoint = await createEndpoint(db, {
    name: 'github',
    destinationUrl: `http://127.0.0.1:${port}/hook`,
    signingSecret: SECRET,
  });
  const event = await recordEvent(db, {
    endpointId: endpoint.id,
    providerEventId: 'delivery-1',
    headers: { 'content-type': 'application/json', ...headers },
    body: BODY,
  });
  return event.id;
}

function deps(overrides: Partial<Parameters<typeof processDelivery>[0]> = {}) {
  return { db, agent, queue: fakeQueue().queue, random: () => 0.5, ...overrides };
}

describe('a successful delivery', () => {
  it('marks the event delivered and records one attempt', async () => {
    const eventId = await anEvent();

    const result = await processDelivery(deps(), { eventId, attempt: 1 });

    expect(result).toBe('delivered');
    expect((await findEventById(db, eventId))?.status).toBe('delivered');

    const attempts = await listAttempts(db, eventId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, status: 'delivered', responseStatus: 200 });
  });

  it('sends the stored bytes under a signature the destination can verify', async () => {
    const eventId = await anEvent();

    await processDelivery(deps(), { eventId, attempt: 1 });

    expect(received).toHaveLength(1);
    expect(received[0]!.body).toBe(BODY.toString());
    expect(verifySignature(BODY, received[0]!.signature, SECRET)).toBe(true);
  });

  it('carries an idempotency key that does not change between attempts', async () => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(500).end('nope');

    const { queue } = fakeQueue();
    await processDelivery(deps({ queue }), { eventId, attempt: 1 });
    await db.query(`UPDATE events SET status = 'failed' WHERE id = $1`, [eventId]);
    await processDelivery(deps({ queue }), { eventId, attempt: 2 });

    expect(received.map((r) => r.idempotencyKey)).toEqual([eventId, eventId]);
    expect(received.map((r) => r.attempt)).toEqual(['1', '2']);
  });

  it('forwards the GitHub event type without forwarding arbitrary headers', async () => {
    const eventId = await anEvent({
      'x-github-event': 'push',
      'x-arbitrary-header': 'must-not-leave-the-relay',
    });

    await processDelivery(deps(), { eventId, attempt: 1 });

    expect(received[0]?.githubEvent).toBe('push');
    expect(received[0]?.arbitraryHeader).toBe('');
  });

  it('does not forward a malformed GitHub event type', async () => {
    const eventId = await anEvent({ 'x-github-event': 'push\r\nx-injected: true' });

    await processDelivery(deps(), { eventId, attempt: 1 });

    expect(received[0]?.githubEvent).toBe('');
  });
});

describe('a failing delivery', () => {
  it('schedules the next attempt with a backoff', async () => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(503).end('unavailable');
    const { added, queue } = fakeQueue();

    const result = await processDelivery(deps({ queue }), { eventId, attempt: 1 });

    expect(result).toBe('retry');
    expect((await findEventById(db, eventId))?.status).toBe('failed');
    expect(added).toHaveLength(1);
    expect(added[0]!.data).toEqual({ eventId, attempt: 2 });
    // base 1000, equal jitter at random()=0.5 -> 750
    expect(added[0]!.delay).toBeGreaterThanOrEqual(500);
    expect(added[0]!.delay).toBeLessThanOrEqual(1_000);
  });

  it('lengthens the wait as attempts accumulate', async () => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(503).end();

    const delays: number[] = [];
    for (const attempt of [1, 2, 3, 4]) {
      const { added, queue } = fakeQueue();
      await db.query(`UPDATE events SET status = 'failed' WHERE id = $1`, [eventId]);
      await processDelivery(deps({ queue }), { eventId, attempt });
      delays.push(added[0]!.delay);
    }

    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[3]!).toBeGreaterThan(delays[0]!);
  });

  it('records the response status and the failure on the attempt row', async () => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(503).end('unavailable');

    await processDelivery(deps(), { eventId, attempt: 1 });

    const [attempt] = await listAttempts(db, eventId);
    expect(attempt).toMatchObject({ status: 'failed', responseStatus: 503 });
  });

  it('dead-letters once the ladder is exhausted', async () => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(503).end();
    const { added, queue } = fakeQueue();
    // The ladder lives in the row, so it is set there rather than claimed in
    // the job payload.
    await db.query(`UPDATE events SET failed_streak = 7, status = 'failed' WHERE id = $1`, [eventId]);

    const result = await processDelivery(deps({ queue }), { eventId, attempt: 8 });

    expect(result).toBe('dead');
    expect((await findEventById(db, eventId))?.status).toBe('dlq');
    expect(added).toHaveLength(0);
  });

  it('will not let a job payload force a dead-letter', async () => {
    // The attempt number and the ladder position both come from the row. A
    // stale or forged payload claiming attempt 99 must not retire an event that
    // has never failed.
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(503).end();

    const result = await processDelivery(deps(), { eventId, attempt: 99 });

    expect(result).toBe('retry');
    const [attempt] = await listAttempts(db, eventId);
    expect(attempt?.attemptNumber).toBe(1);
  });

  it('dead-letters a permanent rejection without burning the ladder', async () => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(404).end('no such hook');
    const { added, queue } = fakeQueue();

    const result = await processDelivery(deps({ queue }), { eventId, attempt: 1 });

    expect(result).toBe('dead');
    expect((await findEventById(db, eventId))?.status).toBe('dlq');
    expect(added).toHaveLength(0);
  });

  it.each([408, 429, 500, 502, 503])('retries a %i', async (status) => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(status).end();

    expect(await processDelivery(deps(), { eventId, attempt: 1 })).toBe('retry');
  });

  it('retries a destination that never answers', async () => {
    const eventId = await anEvent();
    handler = () => {
      /* hang */
    };

    const result = await processDelivery(deps({ timeoutMs: 300 }), { eventId, attempt: 1 });

    expect(result).toBe('retry');
    const [attempt] = await listAttempts(db, eventId);
    expect(attempt).toMatchObject({ status: 'failed', responseStatus: null, error: 'delivery failed' });
  });
});

describe('an open circuit', () => {
  it('reschedules without dialling, and without spending an attempt', async () => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(200).end('ok');
    const circuit = new Circuit({ threshold: 1 });
    const event = await findEventById(db, eventId);
    circuit.recordFailure(event!.endpointId);
    const { added, queue } = fakeQueue();

    const result = await processDelivery(deps({ queue, circuit }), { eventId, attempt: 1 });

    expect(result).toBe('deferred');
    // Nothing was sent, so nothing is an attempt and the ladder has not moved.
    expect(received).toHaveLength(0);
    expect(await listAttempts(db, eventId)).toHaveLength(0);
    expect((await findEventById(db, eventId))?.attemptCount).toBe(0);
    // But it is queued again rather than dropped.
    expect(added).toHaveLength(1);
    expect(added[0]!.jobId).not.toBe(`${eventId}-1`);
  });

  it('opens after enough failures and closes on a success', async () => {
    const eventId = await anEvent();
    const event = await findEventById(db, eventId);
    const circuit = new Circuit({ threshold: 2 });

    handler = (_req, res) => res.writeHead(503).end();
    await processDelivery(deps({ circuit }), { eventId, attempt: 1 });
    await db.query(`UPDATE events SET status = 'failed' WHERE id = $1`, [eventId]);
    await processDelivery(deps({ circuit }), { eventId, attempt: 2 });
    expect(circuit.isOpen(event!.endpointId)).toBe(true);

    circuit.recordSuccess(event!.endpointId);
    handler = (_req, res) => res.writeHead(200).end('ok');
    await db.query(`UPDATE events SET status = 'failed' WHERE id = $1`, [eventId]);
    await processDelivery(deps({ circuit }), { eventId, attempt: 3 });

    expect(circuit.isOpen(event!.endpointId)).toBe(false);
  });
});

describe('duplicate work', () => {
  it('skips an event another worker already delivered', async () => {
    const eventId = await anEvent();
    await processDelivery(deps(), { eventId, attempt: 1 });

    const result = await processDelivery(deps(), { eventId, attempt: 1 });

    expect(result).toBe('skipped');
    expect(received).toHaveLength(1);
    expect(await listAttempts(db, eventId)).toHaveLength(1);
  });

  it('counts a genuine second run as the next attempt, not a duplicate', async () => {
    const eventId = await anEvent();
    handler = (_req, res) => res.writeHead(503).end();

    await processDelivery(deps(), { eventId, attempt: 1 });
    await db.query(`UPDATE events SET status = 'failed' WHERE id = $1`, [eventId]);
    await processDelivery(deps(), { eventId, attempt: 2 });

    const attempts = await listAttempts(db, eventId);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect((await findEventById(db, eventId))?.attemptCount).toBe(2);
  });

  it('dead-letters an event whose endpoint was deleted', async () => {
    const eventId = await anEvent();
    await db.query('DELETE FROM endpoints');

    // The cascade removes the event too, so nothing is left to claim.
    expect(await processDelivery(deps(), { eventId, attempt: 1 })).toBe('skipped');
  });
});
