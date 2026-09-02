import type { Db } from '../db.js';

export interface Endpoint {
  id: string;
  name: string;
  destinationUrl: string;
  signingSecret: string;
  isActive: boolean;
  createdAt: Date;
}

interface EndpointRow {
  id: string;
  name: string;
  destination_url: string;
  signing_secret: string;
  is_active: boolean;
  created_at: Date;
}

function toEndpoint(row: EndpointRow): Endpoint {
  return {
    id: row.id,
    name: row.name,
    destinationUrl: row.destination_url,
    signingSecret: row.signing_secret,
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
     RETURNING *`,
    [input.name, input.destinationUrl, input.signingSecret],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('insert returned no row');
  return toEndpoint(row);
}

export async function findEndpointById(db: Db, id: string): Promise<Endpoint | null> {
  const { rows } = await db.query<EndpointRow>('SELECT * FROM endpoints WHERE id = $1', [id]);
  const row = rows[0];
  return row === undefined ? null : toEndpoint(row);
}

export async function listEndpoints(db: Db): Promise<Endpoint[]> {
  const { rows } = await db.query<EndpointRow>(
    'SELECT * FROM endpoints ORDER BY created_at DESC, id DESC',
  );
  return rows.map(toEndpoint);
}
