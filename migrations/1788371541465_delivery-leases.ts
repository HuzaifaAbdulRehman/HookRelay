import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Without this the ALTER queues behind any long-running transaction, and
  // every query arriving afterwards queues behind the waiting ALTER. Failing
  // fast turns a table-wide stall into a migration you simply run again.
  pgm.sql(`SET lock_timeout = '3s';`);

  // When the current delivery was claimed. A worker that dies mid-delivery
  // leaves the row at 'delivering' forever without this, and no retry can take
  // it back because the claim only accepts pending and failed.
  pgm.sql(`ALTER TABLE events ADD COLUMN claimed_at timestamptz;`);

  // Position in the current retry ladder, as opposed to attempt_count, which is
  // every attempt ever made. They diverge after a replay: the ladder restarts
  // while attempt numbers keep climbing, so replayed attempts do not collide
  // with the rows already in delivery_attempts.
  pgm.sql(`
    ALTER TABLE events
      ADD COLUMN failed_streak integer NOT NULL DEFAULT 0,
      ADD CONSTRAINT events_failed_streak_non_negative CHECK (failed_streak >= 0);
  `);

  // The sweeper asks for work that is due. Partial, because delivered and
  // dead-lettered events are the overwhelming majority on a healthy system and
  // never appear in that query.
  //
  // Built inline rather than CONCURRENTLY, which takes a write lock for the
  // duration. That is fine while this has never been deployed and the table is
  // empty. Against a live table it would need CONCURRENTLY, and since
  // node-pg-migrate wraps each migration in a transaction, that means marking
  // this migration non-transactional as well.
  pgm.sql(`
    CREATE INDEX events_due_for_delivery
      ON events (next_attempt_at, received_at)
      WHERE status IN ('pending', 'failed', 'delivering');
  `);
}

/**
 * Drops the columns, which destroys the claim and ladder state the previous
 * release was writing. That is the honest inverse of adding them and it is not
 * a rollback anyone should reach for under incident pressure: deploy forward.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP INDEX IF EXISTS events_due_for_delivery;');
  pgm.sql('ALTER TABLE events DROP CONSTRAINT IF EXISTS events_failed_streak_non_negative;');
  pgm.sql('ALTER TABLE events DROP COLUMN IF EXISTS failed_streak;');
  pgm.sql('ALTER TABLE events DROP COLUMN IF EXISTS claimed_at;');
}
