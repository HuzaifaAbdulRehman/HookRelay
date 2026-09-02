import type { Db } from '../db.js';
import type { EventStatus } from './events.js';

export interface AttemptRecord {
  eventId: string;
  attemptNumber: number;
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
 * makes the second write a no-op instead of a crash, and the event lands in the
 * same state either way.
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
              next_attempt_at = $4
        WHERE id = $1`,
      [
        attempt.eventId,
        NEXT_STATUS[disposition.kind],
        attempt.attemptNumber,
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

/** Marks an event in flight. Returns false when another worker already finished it. */
export async function claimForDelivery(db: Db, eventId: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE events SET status = 'delivering'
      WHERE id = $1 AND status IN ('pending', 'failed')
      RETURNING id`,
    [eventId],
  );
  return rows.length > 0;
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
