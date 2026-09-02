import type { Queue } from 'bullmq';
import type { Db } from '../db.js';
import { findDueEvents } from '../repository/attempts.js';
import { type DeliveryJobData, enqueueDelivery } from './queue.js';

export interface SweeperDeps {
  db: Db;
  queue: Queue<DeliveryJobData>;
  batchSize?: number;
  graceMs?: number;
}

/**
 * Re-queues work the queue should already hold.
 *
 * Writing to Postgres and enqueuing to Redis cannot be one atomic act, so every
 * path that does both has a window where the row is committed and the job is
 * not: ingest, a scheduled retry, and a worker that died holding a claim. The
 * database is the source of truth, and this is what reconciles Redis back to it.
 *
 * Enqueuing is safe to repeat because the job id is derived from the event and
 * attempt, so anything already queued collapses onto the existing job.
 */
export async function sweepOnce(deps: SweeperDeps): Promise<number> {
  const due = await findDueEvents(deps.db, deps.batchSize ?? 100, deps.graceMs);

  for (const event of due) {
    await enqueueDelivery(deps.queue, { eventId: event.id, attempt: event.attemptNumber });
  }

  return due.length;
}

export interface Sweeper {
  stop: () => void;
}

export function startSweeper(
  deps: SweeperDeps,
  intervalMs = 15_000,
  onError: (err: unknown) => void = () => {},
): Sweeper {
  let running = false;

  const timer = setInterval(() => {
    // A slow sweep must not stack up behind itself; the next tick simply skips.
    if (running) return;
    running = true;
    sweepOnce(deps)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // Never hold the process open for a background reconciliation loop.
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
