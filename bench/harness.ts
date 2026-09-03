import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Percentiles {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank, so every reported value is one that actually occurred. */
export function percentiles(samples: number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export type DestinationMode = 'ok' | 'hang' | 'fail';

export interface Destination {
  url: string;
  hits: () => number;
  setMode: (mode: DestinationMode) => void;
  close: () => Promise<void>;
}

/**
 * A destination we can break on demand.
 *
 * `hang` accepts the connection and never answers, which is the failure that
 * matters: a refused connection returns in microseconds and costs a worker
 * nothing, while a hang holds the slot for the whole timeout.
 */
export async function startDestination(mode: DestinationMode = 'ok'): Promise<Destination> {
  let current = mode;
  let hits = 0;
  const open: import('node:net').Socket[] = [];

  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    if (current === 'hang') return;
    res.writeHead(current === 'fail' ? 503 : 200).end(current === 'fail' ? 'nope' : 'ok');
  });

  server.on('connection', (socket) => open.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits: () => hits,
    setMode: (next) => {
      current = next;
    },
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface Relay {
  base: string;
  apiKey: string;
}

export async function createEndpoint(
  relay: Relay,
  name: string,
  destinationUrl: string,
): Promise<{ id: string; secret: string; ingest: string }> {
  const res = await fetch(`${relay.base}/endpoints`, {
    method: 'POST',
    headers: { authorization: `Bearer ${relay.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, destinationUrl }),
  });
  if (!res.ok) throw new Error(`could not create endpoint: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { id: string; signingSecret: string; ingestPath: string };
  return { id: body.id, secret: body.signingSecret, ingest: `${relay.base}${body.ingestPath}` };
}

/** Returns the ingest round trip in milliseconds. */
export async function deliver(
  ingest: string,
  secret: string,
  deliveryId: string,
): Promise<number> {
  const body = Buffer.from(JSON.stringify({ id: deliveryId }));
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  const started = process.hrtime.bigint();
  const res = await fetch(ingest, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-delivery': deliveryId,
    },
    body,
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

  if (res.status !== 202) throw new Error(`ingest returned ${res.status}`);
  await res.text();
  return elapsed;
}

export function table(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;

  return [
    line(headers),
    line(headers.map(() => '---')),
    ...rows.map((row) => line(headers.map((h) => row[h] ?? ''))),
  ].join('\n');
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
