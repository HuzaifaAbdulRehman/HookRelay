import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 5 * 1024 * 1024,
  });

  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
  }));

  return app;
}
