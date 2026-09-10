import type { Queue } from 'bullmq';
import type { Agent } from 'undici';
import type { Db } from '../db.js';
import { findEndpointById, findSigningSecret } from '../repository/endpoints.js';
import { findEventById } from '../repository/events.js';
import {
  type Disposition,
  claimForDelivery,
  deferDelivery,
  recordAttempt,
} from '../repository/attempts.js';
import type { Circuit } from './circuit.js';
import { sign } from '../signature.js';
import { deliver } from './client.js';
import { DEFAULT_POLICY, type RetryPolicy, backoffMs, isExhausted, isRetryableStatus } from './policy.js';
import { type DeliveryJobData, enqueueDelivery } from './queue.js';

export interface ProcessDeps {
  db: Db;
  agent: Agent;
  queue: Queue<DeliveryJobData>;
  circuit?: Circuit | undefined;
  policy?: RetryPolicy;
  timeoutMs?: number;
  now?: () => Date;
  random?: () => number;
}

export type ProcessResult = Disposition['kind'] | 'skipped' | 'deferred';

const GITHUB_EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

function githubEventType(headers: Record<string, string>): string | undefined {
  const value: unknown = headers['x-github-event'];
  return typeof value === 'string' && GITHUB_EVENT_TYPE.test(value) ? value : undefined;
}

/**
 * Runs one delivery attempt end to end.
 *
 * Separated from the BullMQ wiring so the state machine can be exercised
 * without a queue: the interesting behaviour is which state an event lands in,
 * not that a job was consumed.
 */
export async function processDelivery(
  deps: ProcessDeps,
  job: DeliveryJobData,
): Promise<ProcessResult> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 10_000;

  // Anything already delivered or dead-lettered is left alone. A duplicate job
  // is expected under at-least-once, not an error. The claim also decides which
  // attempt this is, so the number comes from the row rather than the payload
  // and a stale job cannot overwrite a newer attempt.
  const claim = await claimForDelivery(deps.db, job.eventId);
  if (claim === null) return 'skipped';

  const event = await findEventById(deps.db, job.eventId);
  const endpoint = event === null ? null : await findEndpointById(deps.db, event.endpointId);
  const secret = event === null ? null : await findSigningSecret(deps.db, event.endpointId);

  if (event === null || endpoint === null || secret === null) {
    await recordAttempt(
      deps.db,
      {
        eventId: job.eventId,
        attemptNumber: claim.attemptNumber,
        ladderPosition: claim.ladderPosition,
        status: 'failed',
        responseStatus: null,
        responseSnippet: null,
        error: 'endpoint no longer exists',
        durationMs: 0,
      },
      { kind: 'dead' },
    );
    return 'dead';
  }

  // A destination that has failed repeatedly is not dialled again yet. The slot
  // is freed in microseconds instead of being held for the whole timeout, which
  // is what stops one dead endpoint starving every other one.
  if (deps.circuit?.isOpen(event.endpointId) === true) {
    const delay = backoffMs(claim.ladderPosition, policy, deps.random);
    const nextAttemptAt = new Date(now().getTime() + delay);
    await deferDelivery(deps.db, job.eventId, nextAttemptAt);
    await enqueueDelivery(
      deps.queue,
      { eventId: job.eventId, attempt: claim.attemptNumber },
      { delayMs: delay, scheduledFor: nextAttemptAt },
    );
    return 'deferred';
  }

  const eventType = githubEventType(event.headers);
  const outcome = await deliver(deps.agent, {
    url: endpoint.destinationUrl,
    body: event.body,
    timeoutMs,
    headers: {
      'content-type': event.headers['content-type'] ?? 'application/json',
      'x-hub-signature-256': sign(event.body, secret),
      'x-hookrelay-event-id': event.id,
      'x-hookrelay-attempt': String(claim.attemptNumber),
      ...(eventType === undefined ? {} : { 'x-github-event': eventType }),
      // Stable across every retry and every stall recovery of this event, which
      // is what lets a destination deduplicate. The attempt number is not,
      // because a recovered attempt reuses its number.
      'idempotency-key': event.id,
    },
  });

  // Not `!isRetryableStatus(...)`: that is also false for a 404, which is a
  // permanent failure rather than a delivery.
  const succeeded = outcome.status !== null && outcome.status >= 200 && outcome.status < 300;
  const permanent = outcome.status !== null && !succeeded && !isRetryableStatus(outcome.status);

  let disposition: Disposition;
  if (succeeded) {
    disposition = { kind: 'delivered' };
    // Exhaustion and backoff read the ladder position, not the attempt number.
    // After a replay those diverge: the ladder restarts at one while attempt
    // numbers keep climbing, so using the attempt number would dead-letter a
    // replayed event on its first try.
  } else if (permanent || isExhausted(claim.ladderPosition, policy)) {
    disposition = { kind: 'dead' };
  } else {
    const delay = backoffMs(claim.ladderPosition, policy, deps.random);
    disposition = { kind: 'retry', nextAttemptAt: new Date(now().getTime() + delay) };
  }

  if (succeeded) deps.circuit?.recordSuccess(event.endpointId);
  else deps.circuit?.recordFailure(event.endpointId);

  await recordAttempt(
    deps.db,
    {
      eventId: job.eventId,
      attemptNumber: claim.attemptNumber,
      ladderPosition: claim.ladderPosition,
      status: succeeded ? 'delivered' : 'failed',
      responseStatus: outcome.status,
      responseSnippet: outcome.responseSnippet,
      error: outcome.error,
      durationMs: outcome.durationMs,
    },
    disposition,
  );

  // Enqueued after the commit. A crash in this gap leaves the event at `failed`
  // with next_attempt_at set, which is what the sweeper picks up.
  if (disposition.kind === 'retry') {
    await enqueueDelivery(
      deps.queue,
      { eventId: job.eventId, attempt: claim.attemptNumber + 1 },
      {
        delayMs: Math.max(0, disposition.nextAttemptAt.getTime() - now().getTime()),
        scheduledFor: disposition.nextAttemptAt,
      },
    );
  }

  return disposition.kind;
}
