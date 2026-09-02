import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
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
  pgm.sql(`
    CREATE INDEX events_due_for_delivery
      ON events (next_attempt_at, received_at)
      WHERE status IN ('pending', 'failed', 'delivering');
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP INDEX IF EXISTS events_due_for_delivery;');
  pgm.sql('ALTER TABLE events DROP CONSTRAINT IF EXISTS events_failed_streak_non_negative;');
  pgm.sql('ALTER TABLE events DROP COLUMN IF EXISTS failed_streak;');
  pgm.sql('ALTER TABLE events DROP COLUMN IF EXISTS claimed_at;');
}
