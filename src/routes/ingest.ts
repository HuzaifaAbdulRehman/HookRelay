import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db.js';
import { applyRawBodyParsers, requireRawBody } from '../raw-body.js';
import { findEndpointById, findSigningSecret } from '../repository/endpoints.js';
import { recordEvent } from '../repository/events.js';
import { SIGNATURE_HEADER, verifySignature } from '../signature.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GitHub reuses this value when a delivery is replayed, which is what makes it an idempotency key. */
const DELIVERY_ID_HEADER = 'x-github-delivery';

export interface IngestOptions {
  db: Db;
  bodyLimit: number;
}

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export const ingestRoutes: FastifyPluginAsync<IngestOptions> = async (app, opts) => {
  applyRawBodyParsers(app, { bodyLimit: opts.bodyLimit });

  app.post<{ Params: { endpointId: string } }>(
    '/hook/:endpointId',
    { bodyLimit: opts.bodyLimit },
    async (request, reply) => {
      const { endpointId } = request.params;
      if (!UUID.test(endpointId)) {
        return reply.code(404).send({ error: 'unknown endpoint' });
      }

      const endpoint = await findEndpointById(opts.db, endpointId);
      if (endpoint === null || !endpoint.isActive) {
        return reply.code(404).send({ error: 'unknown endpoint' });
      }

      const raw = requireRawBody(request);

      // An ingest URL is an unguessable capability, so telling a caller who
      // already holds one that it exists leaks nothing they did not have. That
      // is what buys a distinguishable 401 here, and a distinguishable 401 is
      // what makes a misconfigured secret debuggable from the provider's own
      // delivery log.
      const secret = await findSigningSecret(opts.db, endpointId);
      if (secret === null || !verifySignature(raw, request.headers[SIGNATURE_HEADER], secret)) {
        return reply.code(401).send({ error: 'invalid signature' });
      }

      const event = await recordEvent(opts.db, {
        endpointId,
        providerEventId: headerString(request.headers[DELIVERY_ID_HEADER]),
        headers: request.headers as Record<string, string>,
        body: raw,
      });

      // Accepted, not processed. Delivery happens after the response, and the
      // producer is told nothing about whether it eventually succeeded.
      return reply.code(202).send({
        id: event.id,
        status: event.status,
        duplicate: !event.inserted,
      });
    },
  );
};
