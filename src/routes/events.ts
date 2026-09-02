import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { listAttempts, replayEvent } from '../repository/attempts.js';
import { findEventById } from '../repository/events.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EventRoutesOptions {
  db: Db;
  apiKey: string;
  onReplayed?: ((eventId: string, attempt: number) => Promise<void>) | undefined;
}

function authorised(request: FastifyRequest, apiKey: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;

  const offered = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(apiKey);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

export const eventRoutes: FastifyPluginAsync<EventRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', async (request, reply) => {
    if (!authorised(request, opts.apiKey)) {
      return reply.code(401).send({ error: 'unauthorised' });
    }
  });

  app.get<{ Params: { id: string } }>('/events/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not found' });

    const event = await findEventById(opts.db, request.params.id);
    if (event === null) return reply.code(404).send({ error: 'not found' });

    return {
      id: event.id,
      endpointId: event.endpointId,
      providerEventId: event.providerEventId,
      status: event.status,
      attemptCount: event.attemptCount,
      receivedAt: event.receivedAt,
      // The payload is not returned. It is the bytes a provider signed, and
      // this route exists to explain a delivery, not to hand back the body.
      attempts: await listAttempts(opts.db, event.id),
    };
  });

  app.post<{ Params: { id: string } }>('/events/:id/replay', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not found' });

    if (!(await replayEvent(opts.db, request.params.id))) {
      // Either it does not exist, or it is delivered or already in flight.
      return reply.code(409).send({ error: 'not replayable' });
    }

    const event = await findEventById(opts.db, request.params.id);
    if (event !== null && opts.onReplayed !== undefined) {
      await opts.onReplayed(event.id, event.attemptCount + 1);
    }

    return reply.code(202).send({ id: request.params.id, status: 'pending' });
  });
};
