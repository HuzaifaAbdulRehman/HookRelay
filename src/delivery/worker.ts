import { Worker } from 'bullmq';
import type { ProcessDeps } from './process.js';
import { processDelivery } from './process.js';
import { DELIVERY_QUEUE, type DeliveryJobData, connectionFor } from './queue.js';

export interface WorkerOptions {
  redisUrl: string;
  concurrency?: number;
}

/**
 * BullMQ has no job timeout and renews a lock indefinitely, so a destination
 * that accepts a connection and never answers would hold a slot forever and the
 * stalled checker would never reclaim it. The deadline lives in the HTTP call
 * instead, which is why `deliver` takes one.
 *
 * A lock lost to a slow event loop or a Redis blip leaves the job running while
 * another worker picks it up. Cancelling on `lockRenewalFailed` keeps that from
 * becoming two live deliveries of the same event.
 */
export function createDeliveryWorker(
  deps: Omit<ProcessDeps, 'queue'> & { queue: ProcessDeps['queue'] },
  options: WorkerOptions,
): Worker<DeliveryJobData> {
  const worker = new Worker<DeliveryJobData>(
    DELIVERY_QUEUE,
    async (job) => processDelivery(deps, job.data),
    {
      connection: connectionFor(options.redisUrl),
      concurrency: options.concurrency ?? 20,
    },
  );

  worker.on('lockRenewalFailed', (jobIds: string[]) => {
    for (const jobId of jobIds) void worker.cancelJob?.(jobId, 'lock lost');
  });

  return worker;
}
