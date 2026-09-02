import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { eventRoutes } from './routes/events.js';
import { ingestRoutes } from './routes/ingest.js';

export interface ServerDeps {
  config: Config;
  db: Db;
  onAccepted?: ((eventId: string) => Promise<void>) | undefined;
  onReplayed?: ((eventId: string, attempt: number) => Promise<void>) | undefined;
}

export function buildServer({ config, db, onAccepted, onReplayed }: ServerDeps): FastifyInstance {
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
  app.register(ingestRoutes, { db, bodyLimit: config.INGEST_BODY_LIMIT_BYTES, onAccepted });

  // Without a key the management routes do not exist, rather than existing
  // behind a default one.
  if (config.API_KEY !== undefined) {
    app.register(eventRoutes, { db, apiKey: config.API_KEY, onReplayed });
  }

  return app;
}
