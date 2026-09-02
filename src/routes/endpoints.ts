import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import {
  createEndpoint,
  deactivateEndpoint,
  findEndpointById,
  listEndpoints,
} from '../repository/endpoints.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  destinationUrl: z.string().min(1).max(2_000),
});

export interface EndpointRoutesOptions {
  db: Db;
}

export const endpointRoutes: FastifyPluginAsync<EndpointRoutesOptions> = async (app, opts) => {
  app.post('/endpoints', async (request, reply) => {
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid endpoint', issues: parsed.error.issues });
    }

    // Generated here rather than accepted from the caller, so a weak secret
    // cannot be chosen, and returned exactly once because no read path will
    // ever hand it back again.
    const signingSecret = randomBytes(32).toString('base64url');
    const endpoint = await createEndpoint(opts.db, { ...parsed.data, signingSecret });

    return reply.code(201).send({
      ...endpoint,
      signingSecret,
      ingestPath: `/hook/${endpoint.id}`,
      note: 'The signing secret is shown once and is not retrievable afterwards.',
    });
  });

  app.get('/endpoints', async () => ({ endpoints: await listEndpoints(opts.db) }));

  app.delete<{ Params: { id: string } }>('/endpoints/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not found' });

    // Deactivated rather than deleted. Removing the row would cascade away the
    // events and their delivery history, which is the record of what happened.
    if (!(await deactivateEndpoint(opts.db, request.params.id))) {
      return reply.code(404).send({ error: 'not found' });
    }

    return reply.code(200).send({ id: request.params.id, isActive: false });
  });

  app.get<{ Params: { id: string } }>('/endpoints/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not found' });

    const endpoint = await findEndpointById(opts.db, request.params.id);
    if (endpoint === null) return reply.code(404).send({ error: 'not found' });

    return endpoint;
  });
};
