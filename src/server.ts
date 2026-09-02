import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ingestRoutes } from './routes/ingest.js';

export interface ServerDeps {
  config: Config;
  db: Db;
}

export function buildServer({ config, db }: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: config.INGEST_BODY_LIMIT_BYTES,
  });

  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
  }));

  // Registered as its own plugin so the raw-body content-type parsers stay
  // encapsulated to the ingest routes.
  app.register(ingestRoutes, { db, bodyLimit: config.INGEST_BODY_LIMIT_BYTES });

  return app;
}
