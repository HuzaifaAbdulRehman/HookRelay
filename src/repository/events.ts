import type { Db } from '../db.js';

export const EVENT_STATUSES = [
  'pending',
  'delivering',
  'delivered',
  'failed',
  'dlq',
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface RecordEventInput {
  endpointId: string;
  /** Provider delivery id, e.g. GitHub's X-GitHub-Delivery. Null when the provider sends none. */
  providerEventId: string | null;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RecordedEvent {
  id: string;
  status: EventStatus;
  /** False when an event with this provider id was already recorded for this endpoint. */
  inserted: boolean;
}

/**
 * Records an inbound event, collapsing repeat deliveries of the same provider id.
 *
 * A plain `DO NOTHING` returns no row on conflict, and the widely posted
 * CTE workaround can return no row at all under concurrency because every
 * statement in a CTE shares one snapshot. `DO UPDATE` is the form Postgres
 * documents as always yielding exactly one row.
 *
 * The caller gets the existing status back because a redelivery of an event we
 * never finished delivering has to be re-driven, not silently dropped.
 */
export async function recordEvent(db: Db, input: RecordEventInput): Promise<RecordedEvent> {
  const { rows } = await db.query<{ id: string; status: EventStatus; inserted: boolean }>(
    `INSERT INTO events (endpoint_id, provider_event_id, headers, body)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint_id, provider_event_id) WHERE provider_event_id IS NOT NULL
     DO UPDATE SET provider_event_id = events.provider_event_id
     RETURNING id, status, (xmax = 0) AS inserted`,
    [input.endpointId, input.providerEventId, JSON.stringify(input.headers), input.body],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('upsert returned no row');
  return row;
}

export interface StoredEvent {
  id: string;
  endpointId: string;
  providerEventId: string | null;
  headers: Record<string, string>;
  body: Buffer;
  status: EventStatus;
  attemptCount: number;
  nextAttemptAt: Date | null;
  receivedAt: Date;
}

interface EventRow {
  id: string;
  endpoint_id: string;
  provider_event_id: string | null;
  headers: Record<string, string>;
  body: Buffer;
  status: EventStatus;
  attempt_count: number;
  next_attempt_at: Date | null;
  received_at: Date;
}

const EVENT_COLUMNS =
  'id, endpoint_id, provider_event_id, headers, body, status, attempt_count, next_attempt_at, received_at';

export async function findEventById(db: Db, id: string): Promise<StoredEvent | null> {
  const { rows } = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;

  return {
    id: row.id,
    endpointId: row.endpoint_id,
    providerEventId: row.provider_event_id,
    headers: row.headers,
    body: row.body,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    receivedAt: row.received_at,
  };
}

export interface EventSummary {
  id: string;
  endpointId: string;
  providerEventId: string | null;
  status: EventStatus;
  attemptCount: number;
  receivedAt: Date;
  bodyBytes: number;
}

export interface ListEventsQuery {
  endpointId?: string | undefined;
  status?: EventStatus | undefined;
  limit?: number | undefined;
}

export const MAX_EVENT_PAGE = 100;

/**
 * Lists events without their payloads. The body is toasted out of line and can
 * be megabytes, so a list view that selected it would read every one of them to
 * render a table that shows none.
 */
export async function listEvents(db: Db, query: ListEventsQuery = {}): Promise<EventSummary[]> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? MAX_EVENT_PAGE), 1), MAX_EVENT_PAGE);

  const { rows } = await db.query<{
    id: string;
    endpoint_id: string;
    provider_event_id: string | null;
    status: EventStatus;
    attempt_count: number;
    received_at: Date;
    body_bytes: number;
  }>(
    `SELECT id, endpoint_id, provider_event_id, status, attempt_count, received_at,
            octet_length(body) AS body_bytes
       FROM events
      WHERE ($1::uuid IS NULL OR endpoint_id = $1)
        AND ($2::text IS NULL OR status = $2)
      ORDER BY received_at DESC, id DESC
      LIMIT $3`,
    [query.endpointId ?? null, query.status ?? null, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    endpointId: row.endpoint_id,
    providerEventId: row.provider_event_id,
    status: row.status,
    attemptCount: row.attempt_count,
    receivedAt: row.received_at,
    bodyBytes: Number(row.body_bytes),
  }));
}

export async function countEventsByStatus(db: Db): Promise<Record<string, number>> {
  const { rows } = await db.query<{ status: string; count: string }>(
    'SELECT status, count(*)::text AS count FROM events GROUP BY status',
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

export async function countEventsForEndpoint(db: Db, endpointId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM events WHERE endpoint_id = $1',
    [endpointId],
  );
  return Number(rows[0]?.count ?? 0);
}
