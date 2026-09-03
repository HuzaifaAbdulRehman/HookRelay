import { Queue } from 'bullmq';

export const DELIVERY_QUEUE = 'delivery';

export interface DeliveryJobData {
  eventId: string;
  attempt: number;
}

export function connectionFor(redisUrl: string) {
  return { url: redisUrl, maxRetriesPerRequest: null } as const;
}

/**
 * One job is one delivery attempt.
 *
 * `attempts: 1` and no backoff is deliberate. BullMQ freezes those options into
 * the job at enqueue time and offers no way to change them afterwards, so a
 * queue-owned ladder cannot be adjusted for deliveries already scheduled, and a
 * long ladder would park every payload in Redis for the whole window. Postgres
 * owns the policy and the history; Redis only holds what is imminent.
 */
export function createDeliveryQueue(
  redisUrl: string,
  name: string = DELIVERY_QUEUE,
): Queue<DeliveryJobData> {
  return new Queue<DeliveryJobData>(name, {
    connection: connectionFor(redisUrl),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 24 * 3_600, count: 5_000 },
    },
  });
}

/**
 * Stable per attempt, so a re-enqueue after a crash collapses onto the same job.
 *
 * Separated with `-` rather than `:`, which BullMQ v6 rejects in a custom id.
 * The event id is a uuid of fixed length, so the trailing segment is still
 * unambiguously the attempt number.
 */
export function jobIdFor(eventId: string, attempt: number): string {
  return `${eventId}-${attempt}`;
}

export async function enqueueDelivery(
  queue: Queue<DeliveryJobData>,
  data: DeliveryJobData,
  delayMs = 0,
): Promise<void> {
  await queue.add('deliver', data, {
    jobId: jobIdFor(data.eventId, data.attempt),
    delay: delayMs,
  });
}
