import type { Queue } from 'bullmq';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepOnce } from '../src/delivery/sweeper.js';
import type { DeliveryJobData } from '../src/delivery/queue.js';
import {
  claimForDelivery,
  findDueEvents,
  listAttempts,
  recordAttempt,
  replayEvent,
} from '../src/repository/attempts.js';
import { createEndpoint } from '../src/repository/endpoints.js';
import { findEventById, recordEvent } from '../src/repository/events.js';
import { createTestPool, truncateAll } from './helpers/db.js';

const db: pg.Pool = createTestPool();

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

function fakeQueue() {
  const added: DeliveryJobData[] = [];
  const ids = new Set<string>();
  return {
    added,
    queue: {
      add: async (_n: string, data: DeliveryJobData, opts: { jobId: string }) => {
        if (ids.has(opts.jobId)) return;
        ids.add(opts.jobId);
        added.push(data);
      },
    } as unknown as Queue<DeliveryJobData>,
  };
}

async function anEvent(): Promise<string> {
  const endpoint = await createEndpoint(db, {
    name: 'github',
    destinationUrl: 'https://example.com/hook',
    signingSecret: 'secret',
  });
  const event = await recordEvent(db, {
    endpointId: endpoint.id,
    providerEventId: null,
    headers: {},
    body: Buffer.from('{}'),
  });
  return event.id;
}

describe('claiming under a lease', () => {
  it('refuses an event another worker is actively delivering', async () => {
    const eventId = await anEvent();
    expect(await claimForDelivery(db, eventId)).not.toBeNull();

    expect(await claimForDelivery(db, eventId)).toBeNull();
  });

  it('takes back an event whose worker died holding the claim', async () => {
    // This is the bug the lease exists for. Without it the row sits at
    // 'delivering' forever, and a retry is turned away by the same guard that
    // is meant to protect the delivery.
    const eventId = await anEvent();
    await claimForDelivery(db, eventId);
    await db.query(`UPDATE events SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [
      eventId,
    ]);

    const claim = await claimForDelivery(db, eventId);

    expect(claim).not.toBeNull();
    expect(claim?.attemptNumber).toBe(1);
  });

  it('hands out attempt numbers that keep climbing', async () => {
    const eventId = await anEvent();

    const first = await claimForDelivery(db, eventId);
    await recordAttempt(
      db,
      {
        eventId,
        attemptNumber: first!.attemptNumber,
        ladderPosition: first!.ladderPosition,
        status: 'failed',
        responseStatus: 503,
        responseSnippet: null,
        error: null,
        durationMs: 0,
      },
      { kind: 'retry', nextAttemptAt: new Date() },
    );

    const second = await claimForDelivery(db, eventId);

    expect(first?.attemptNumber).toBe(1);
    expect(second?.attemptNumber).toBe(2);
    expect(second?.ladderPosition).toBe(2);
  });
});

describe('replay', () => {
  async function deadLetter(): Promise<string> {
    const eventId = await anEvent();
    for (const n of [1, 2, 3]) {
      const claim = await claimForDelivery(db, eventId);
      await recordAttempt(
        db,
        {
          eventId,
          attemptNumber: claim!.attemptNumber,
          ladderPosition: claim!.ladderPosition,
          status: 'failed',
          responseStatus: 503,
          responseSnippet: null,
          error: null,
          durationMs: 0,
        },
        n === 3 ? { kind: 'dead' } : { kind: 'retry', nextAttemptAt: new Date() },
      );
    }
    return eventId;
  }

  it('restarts the ladder without losing the attempt history', async () => {
    const eventId = await deadLetter();
    expect((await findEventById(db, eventId))?.status).toBe('dlq');

    expect(await replayEvent(db, eventId)).toEqual({ nextAttemptNumber: 4 });

    const event = await findEventById(db, eventId);
    expect(event?.status).toBe('pending');
    // Three attempts still on record, and the ladder back at the start.
    expect(await listAttempts(db, eventId)).toHaveLength(3);
    expect(event?.attemptCount).toBe(3);
  });

  it('numbers a replayed attempt after the ones already recorded', async () => {
    // If a replay restarted attempt numbers at 1, the insert would collide with
    // the existing row and be swallowed by ON CONFLICT DO NOTHING, so the new
    // attempt would simply never appear in the log.
    const eventId = await deadLetter();
    await replayEvent(db, eventId);

    const claim = await claimForDelivery(db, eventId);

    expect(claim?.attemptNumber).toBe(4);
    expect(claim?.ladderPosition).toBe(1);
  });

  it('refuses to replay something already delivered', async () => {
    const eventId = await anEvent();
    const claim = await claimForDelivery(db, eventId);
    await recordAttempt(
      db,
      {
        eventId,
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

    expect(await replayEvent(db, eventId)).toBeNull();
  });
});

describe('the sweeper', () => {
  it('picks up an event that was stored but never queued', async () => {
    const eventId = await anEvent();
    await db.query(`UPDATE events SET received_at = now() - interval '5 minutes' WHERE id = $1`, [
      eventId,
    ]);
    const { added, queue } = fakeQueue();

    expect(await sweepOnce({ db, queue })).toBe(1);
    expect(added).toEqual([{ eventId, attempt: 1 }]);
  });

  it('leaves a fresh event alone, because ingest has probably just queued it', async () => {
    await anEvent();
    const { added, queue } = fakeQueue();

    expect(await sweepOnce({ db, queue })).toBe(0);
    expect(added).toHaveLength(0);
  });

  it('picks up a retry whose schedule has passed', async () => {
    const eventId = await anEvent();
    const claim = await claimForDelivery(db, eventId);
    await recordAttempt(
      db,
      {
        eventId,
        attemptNumber: claim!.attemptNumber,
        ladderPosition: claim!.ladderPosition,
        status: 'failed',
        responseStatus: 503,
        responseSnippet: null,
        error: null,
        durationMs: 0,
      },
      { kind: 'retry', nextAttemptAt: new Date(Date.now() - 60_000) },
    );
    const { added, queue } = fakeQueue();

    await sweepOnce({ db, queue });

    expect(added).toEqual([{ eventId, attempt: 2 }]);
  });

  it('leaves a retry that is not due yet', async () => {
    const eventId = await anEvent();
    const claim = await claimForDelivery(db, eventId);
    await recordAttempt(
      db,
      {
        eventId,
        attemptNumber: claim!.attemptNumber,
        ladderPosition: claim!.ladderPosition,
        status: 'failed',
        responseStatus: 503,
        responseSnippet: null,
        error: null,
        durationMs: 0,
      },
      { kind: 'retry', nextAttemptAt: new Date(Date.now() + 600_000) },
    );
    const { added, queue } = fakeQueue();

    expect(await sweepOnce({ db, queue })).toBe(0);
    expect(added).toHaveLength(0);
  });

  it('recovers an event abandoned mid-delivery', async () => {
    const eventId = await anEvent();
    await claimForDelivery(db, eventId);
    await db.query(`UPDATE events SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [
      eventId,
    ]);
    const { added, queue } = fakeQueue();

    await sweepOnce({ db, queue });

    expect(added).toEqual([{ eventId, attempt: 1 }]);
  });

  it('ignores delivered and dead-lettered events', async () => {
    const delivered = await anEvent();
    const dead = await anEvent();
    await db.query(`UPDATE events SET status='delivered', received_at = now() - interval '1 hour' WHERE id=$1`, [delivered]);
    await db.query(`UPDATE events SET status='dlq', received_at = now() - interval '1 hour' WHERE id=$1`, [dead]);
    const { queue } = fakeQueue();

    expect(await sweepOnce({ db, queue })).toBe(0);
  });

  it('does not double-queue something already waiting', async () => {
    const eventId = await anEvent();
    await db.query(`UPDATE events SET received_at = now() - interval '5 minutes' WHERE id = $1`, [
      eventId,
    ]);
    const { added, queue } = fakeQueue();

    await sweepOnce({ db, queue });
    await sweepOnce({ db, queue });

    // The stable job id is what makes a repeated sweep harmless.
    expect(added).toHaveLength(1);
  });

  it('reports nothing due on a healthy system', async () => {
    expect(await findDueEvents(db)).toEqual([]);
  });
});
