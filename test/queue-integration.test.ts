import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryQueue, enqueueDelivery, jobIdFor } from '../src/delivery/queue.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Constructs a real Queue against a real Redis.
 *
 * The rest of the delivery suite drives `processDelivery` with a fake queue,
 * which is right for testing the state machine and useless for catching a
 * broken connection. BullMQ v6 made ioredis an optional peer dependency, and
 * the whole suite stayed green while the app could not start at all.
 */
// A queue name of its own, because a running HookRelay would otherwise consume
// these jobs before the assertions could see them. Sharing a queue with whatever
// happens to be running is not isolation.
const queue = createDeliveryQueue(REDIS_URL, `delivery-test-${process.pid}`);

beforeAll(async () => {
  await queue.waitUntilReady();
});

beforeEach(async () => {
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
});

describe('the delivery queue', () => {
  it('connects to redis and accepts a job', async () => {
    await enqueueDelivery(queue, { eventId: 'event-1', attempt: 1 });

    const jobs = await queue.getJobs(['waiting', 'delayed']);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ eventId: 'event-1', attempt: 1 });
  });

  it('holds a delayed job rather than making it available', async () => {
    const scheduledFor = new Date(Date.now() + 60_000);
    await enqueueDelivery(
      queue,
      { eventId: 'event-1', attempt: 2 },
      { delayMs: 60_000, scheduledFor },
    );

    expect(await queue.getWaitingCount()).toBe(0);
    expect(await queue.getDelayedCount()).toBe(1);
  });

  it('collapses a repeated enqueue of the same attempt', async () => {
    // A crash between the database commit and the enqueue means the sweeper
    // will re-add this job. The stable id is what stops that delivering twice.
    await enqueueDelivery(queue, { eventId: 'event-1', attempt: 1 });
    await enqueueDelivery(queue, { eventId: 'event-1', attempt: 1 });

    expect(await queue.getJobCountByTypes('waiting', 'delayed')).toBe(1);
  });

  it('keeps separate attempts of one event apart', async () => {
    await enqueueDelivery(queue, { eventId: 'event-1', attempt: 1 });
    await enqueueDelivery(queue, { eventId: 'event-1', attempt: 2 });

    expect(await queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
    expect(jobIdFor('event-1', 1)).not.toBe(jobIdFor('event-1', 2));
  });

  it('keeps a deferred run separate from the active attempt', async () => {
    const scheduledFor = new Date(Date.now() + 60_000);

    await enqueueDelivery(queue, { eventId: 'event-1', attempt: 1 });
    await enqueueDelivery(
      queue,
      { eventId: 'event-1', attempt: 1 },
      { delayMs: 60_000, scheduledFor },
    );

    expect(await queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
    expect(jobIdFor('event-1', 1, scheduledFor)).not.toBe(jobIdFor('event-1', 1));
  });
});
