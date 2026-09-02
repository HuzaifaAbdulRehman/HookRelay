import pg from 'pg';
import type { Config } from './config.js';

export type Db = pg.Pool;

export function createPool(config: Config): Db {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    // A query that cannot get a connection should fail fast rather than pile up
    // behind whatever is holding the pool.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}
