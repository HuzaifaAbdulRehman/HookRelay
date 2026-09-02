import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);

const ADMIN_URL = 'postgres://hookrelay:hookrelay@localhost:5432/postgres';
const TEST_DB = 'hookrelay_test';

export const TEST_DATABASE_URL = `postgres://hookrelay:hookrelay@localhost:5432/${TEST_DB}`;

/**
 * Migrations run through the same CLI the app uses rather than a bespoke
 * in-test schema, so a migration that only works in tests cannot exist.
 */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE ${TEST_DB}`);
    }
  } finally {
    await admin.end();
  }

  await execFileAsync(
    process.execPath,
    ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'],
    { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL } },
  );
}
