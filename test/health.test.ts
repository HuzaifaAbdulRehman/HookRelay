import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createTestPool } from './helpers/db.js';

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://hookrelay:hookrelay@localhost:5432/hookrelay_test',
  REDIS_URL: 'redis://localhost:6379',
});

const db: pg.Pool = createTestPool();

afterAll(async () => {
  await db.end();
});

describe('GET /health', () => {
  it('reports ok with an uptime', async () => {
    const app = buildServer({ config, db });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    expect(res.json().uptime).toBeTypeOf('number');

    await app.close();
  });

  it('404s an unknown route', async () => {
    const app = buildServer({ config, db });

    const res = await app.inject({ method: 'GET', url: '/nope' });

    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
