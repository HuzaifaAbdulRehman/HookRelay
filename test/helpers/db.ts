import pg from 'pg';
import { TEST_DATABASE_URL } from './global-setup.js';

export function createTestPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
}

/** Cheaper than re-running migrations, and RESTART IDENTITY keeps attempt ids predictable. */
export async function truncateAll(db: pg.Pool): Promise<void> {
  await db.query('TRUNCATE endpoints, events, delivery_attempts RESTART IDENTITY CASCADE');
}
