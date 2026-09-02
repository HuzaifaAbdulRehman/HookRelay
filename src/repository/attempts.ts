import type { Db } from '../db.js';
import type { EventStatus } from './events.js';

/** How long a claim is honoured before another worker may take the event back. */
export const CLAIM_LEASE_MS = 60_000;

export interface AttemptRecord {
  eventId: string;
  /** Monotonic across the life of the event, so a replayed attempt never collides. */
  attemptNumber: number;
  /** Position in the current ladder, which a replay resets. */
  ladderPosition: number;
  status: 'delivered' | 'failed';
  responseStatus: number | null;
  responseSnippet: string | null;
  error: string | null;
  durationMs: number;
}

export type Disposition =
  | { kind: 'delivered' }
  | { kind: 'retry'; nextAttemptAt: Date }
  | { kind: 'dead' };

const NEXT_STATUS: Record<Disposition['kind'], EventStatus> = {
  delivered: 'delivered',
  retry: 'failed',
  dead: 'dlq',
};

/**
 * Writes the attempt and moves the event in one transaction.
 *
 * Delivery is at-least-once, so the same attempt can be processed twice after a
 * worker loses its lock. The unique constraint on (event_id, attempt_number)
 * makes the second insert a no-op, and every counter is written as an absolute
 * value rather than incremented, so a duplicate run cannot double-count the
 * ladder.
 */
export async function recordAttempt(
  db: Db,
  attempt: AttemptRecord,
  disposition: Disposition,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO delivery_attempts
         (event_id, attempt_number, status, response_status, response_snippet, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id, attempt_number) DO NOTHING`,
      [
        attempt.eventId,
        attempt.attemptNumber,
        attempt.status,
        attempt.responseStatus,
        attempt.responseSnippet,
        attempt.error,
        attempt.durationMs,
      ],
    );

    await client.query(
      `UPDATE events
          SET status = $2,
              attempt_count = GREATEST(attempt_count, $3),
              failed_streak = $4,
              next_attempt_at = $5,
              claimed_at = NULL
        WHERE id = $1`,
      [
        attempt.eventId,
        NEXT_STATUS[disposition.kind],
        attempt.attemptNumber,
        disposition.kind === 'delivered' ? 0 : attempt.ladderPosition,
        disposition.kind === 'retry' ? disposition.nextAttemptAt : null,
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface Claim {
  attemptNumber: number;
  ladderPosition: number;
}

/**
 * Takes ownership of an event for one delivery.
 *
 * A crashed worker leaves the row at 'delivering' with nothing to move it, so
 * the claim also accepts an event whose lease has expired. Without that, one
 * crash strands an event permanently and BullMQ's own stalled-job recovery
 * cannot help, because the retry would be turned away by this same guard.
 */
export async function claimForDelivery(
  db: Db,
  eventId: string,
  leaseMs: number = CLAIM_LEASE_MS,
): Promise<Claim | null> {
  const { rows } = await db.query<{ attempt_count: number; failed_streak: number }>(
    `UPDATE events
        SET status = 'delivering', claimed_at = now()
      WHERE id = $1
        AND (
          status IN ('pending', 'failed')
          OR (status = 'delivering' AND claimed_at < now() - make_interval(secs => $2))
        )
      RETURNING attempt_count, failed_streak`,
    [eventId, leaseMs / 1000],
  );

  const row = rows[0];
  if (row === undefined) return null;

  return {
    attemptNumber: row.attempt_count + 1,
    ladderPosition: row.failed_streak + 1,
  };
}

/**
 * Puts a dead-lettered event back at the start of a fresh ladder.
 *
 * The affected-row count is the decision, so two concurrent replays cannot both
 * succeed, and the attempt number comes back from the same statement rather
 * than a second read a worker could interleave with.
 */
export async function replayEvent(
  db: Db,
  eventId: string,
): Promise<{ nextAttemptNumber: number } | null> {
  const { rows } = await db.query<{ attempt_count: number }>(
    `UPDATE events
        SET status = 'pending', failed_streak = 0, next_attempt_at = NULL, claimed_at = NULL
      WHERE id = $1 AND status IN ('dlq', 'failed')
      RETURNING attempt_count`,
    [eventId],
  );

  const row = rows[0];
  return row === undefined ? null : { nextAttemptNumber: row.attempt_count + 1 };
}

export interface DueEvent {
  id: string;
  attemptNumber: number;
}

/**
 * Events that should be in the queue and are not.
 *
 * Three ways that happens: the ingest committed and then crashed before
 * enqueuing, an attempt committed its retry schedule and then crashed before
 * enqueuing the next one, or a worker died holding a claim. The stable job id
 * is what keeps this from double-queueing anything already in Redis.
 */
export async function findDueEvents(
  db: Db,
  limit = 100,
  graceMs = 30_000,
  leaseMs: number = CLAIM_LEASE_MS,
): Promise<DueEvent[]> {
  const { rows } = await db.query<{ id: string; attempt_count: number }>(
    `SELECT id, attempt_count
       FROM events
      WHERE (status = 'pending'    AND received_at    < now() - make_interval(secs => $2))
         OR (status = 'failed'     AND next_attempt_at <= now())
         OR (status = 'delivering' AND claimed_at     < now() - make_interval(secs => $3))
      ORDER BY next_attempt_at NULLS FIRST, received_at
      LIMIT $1`,
    [limit, graceMs / 1000, leaseMs / 1000],
  );

  return rows.map((row) => ({ id: row.id, attemptNumber: row.attempt_count + 1 }));
}

export interface StoredAttempt {
  attemptNumber: number;
  status: string;
  responseStatus: number | null;
  error: string | null;
  durationMs: number | null;
}

export async function listAttempts(db: Db, eventId: string): Promise<StoredAttempt[]> {
  const { rows } = await db.query<{
    attempt_number: number;
    status: string;
    response_status: number | null;
    error: string | null;
    duration_ms: number | null;
  }>(
    `SELECT attempt_number, status, response_status, error, duration_ms
       FROM delivery_attempts
      WHERE event_id = $1
      ORDER BY attempt_number`,
    [eventId],
  );

  return rows.map((row) => ({
    attemptNumber: row.attempt_number,
    status: row.status,
    responseStatus: row.response_status,
    error: row.error,
    durationMs: row.duration_ms,
  }));
}
