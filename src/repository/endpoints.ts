import type { Db } from '../db.js';

/**
 * Deliberately without the signing secret. Read paths feed the API and the
 * dashboard, and a secret that is never on the object cannot be serialised out
 * of one by a later `reply.send(endpoint)`.
 */
export interface Endpoint {
  id: string;
  name: string;
  destinationUrl: string;
  isActive: boolean;
  createdAt: Date;
}

const COLUMNS = 'id, name, destination_url, is_active, created_at';

export const MAX_ENDPOINT_PAGE = 100;

interface EndpointRow {
  id: string;
  name: string;
  destination_url: string;
  is_active: boolean;
  created_at: Date;
}

function toEndpoint(row: EndpointRow): Endpoint {
  return {
    id: row.id,
    name: row.name,
    destinationUrl: row.destination_url,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export interface CreateEndpointInput {
  name: string;
  destinationUrl: string;
  signingSecret: string;
}

export async function createEndpoint(db: Db, input: CreateEndpointInput): Promise<Endpoint> {
  const { rows } = await db.query<EndpointRow>(
    `INSERT INTO endpoints (name, destination_url, signing_secret)
     VALUES ($1, $2, $3)
     RETURNING ${COLUMNS}`,
    [input.name, input.destinationUrl, input.signingSecret],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('insert returned no row');
  return toEndpoint(row);
}

export async function findEndpointById(db: Db, id: string): Promise<Endpoint | null> {
  const { rows } = await db.query<EndpointRow>(
    `SELECT ${COLUMNS} FROM endpoints WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : toEndpoint(row);
}

export async function listEndpoints(db: Db, limit = MAX_ENDPOINT_PAGE): Promise<Endpoint[]> {
  const clamped = Math.min(Math.max(Math.trunc(limit), 1), MAX_ENDPOINT_PAGE);

  const { rows } = await db.query<EndpointRow>(
    `SELECT ${COLUMNS} FROM endpoints ORDER BY created_at DESC, id DESC LIMIT $1`,
    [clamped],
  );
  return rows.map(toEndpoint);
}

/**
 * Stops an endpoint accepting deliveries without deleting it. A delete would
 * cascade away every event and its attempt history, which is the record of what
 * actually happened.
 */
export async function deactivateEndpoint(db: Db, id: string): Promise<boolean> {
  const { rows } = await db.query(
    'UPDATE endpoints SET is_active = false WHERE id = $1 AND is_active RETURNING id',
    [id],
  );
  return rows.length > 0;
}

/**
 * The one path that needs the secret asks for it by name, so every other caller
 * has to go out of its way to get hold of one.
 */
export async function findSigningSecret(db: Db, id: string): Promise<string | null> {
  const { rows } = await db.query<{ signing_secret: string }>(
    'SELECT signing_secret FROM endpoints WHERE id = $1',
    [id],
  );
  return rows[0]?.signing_secret ?? null;
}
