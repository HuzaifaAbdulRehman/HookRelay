import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);

const TEST_DB = 'hookrelay_test';

// Derived from DATABASE_URL so the harness follows wherever the database is,
// rather than assuming localhost and these credentials.
const base = new URL(
  process.env.DATABASE_URL ?? 'postgres://hookrelay:hookrelay@localhost:5432/hookrelay',
);

function withDatabase(name: string): string {
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  return url.toString();
}

const ADMIN_URL = withDatabase('postgres');

export const TEST_DATABASE_URL = withDatabase(TEST_DB);

/**
 * Migrations run through the same CLI the app uses rather than a bespoke
 * in-test schema, so a migration that only works in tests cannot exist.
 */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    // Postgres has no CREATE DATABASE IF NOT EXISTS, and a SELECT-then-CREATE
    // races a second runner. The duplicate-database error is the check.
    // TEST_DB is a module constant; identifiers cannot be parameterised.
    try {
      await admin.query(`CREATE DATABASE ${TEST_DB}`);
    } catch (err) {
      if ((err as { code?: string }).code !== '42P04') throw err;
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
