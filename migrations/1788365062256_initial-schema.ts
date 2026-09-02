import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE endpoints (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name            text NOT NULL,
      destination_url text NOT NULL,
      signing_secret  text NOT NULL,
      is_active       boolean NOT NULL DEFAULT true,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT endpoints_name_not_blank CHECK (length(btrim(name)) > 0)
    );
  `);

  pgm.sql(`
    CREATE TABLE events (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint_id       uuid NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
      provider_event_id text,
      headers           jsonb NOT NULL,
      body              bytea NOT NULL,
      status            text NOT NULL DEFAULT 'pending',
      attempt_count     integer NOT NULL DEFAULT 0,
      next_attempt_at   timestamptz,
      received_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT events_status_check
        CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dlq')),
      CONSTRAINT events_attempt_count_non_negative CHECK (attempt_count >= 0)
    );
  `);

  // Partial, so rows from providers that send no delivery id never enter the btree.
  // NULL means "identity unknown", not "identity shared" -- two such events are
  // distinct events, so collapsing them with NULLS NOT DISTINCT would drop data.
  pgm.sql(`
    CREATE UNIQUE INDEX events_endpoint_provider_key
      ON events (endpoint_id, provider_event_id)
      WHERE provider_event_id IS NOT NULL;
  `);

  pgm.sql(`
    CREATE TABLE delivery_attempts (
      id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id         uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
      attempt_number   integer NOT NULL,
      status           text NOT NULL,
      response_status  integer,
      response_snippet text,
      error            text,
      duration_ms      integer,
      attempted_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT delivery_attempts_event_attempt_key UNIQUE (event_id, attempt_number),
      CONSTRAINT delivery_attempts_status_check CHECK (status IN ('delivered', 'failed')),
      CONSTRAINT delivery_attempts_attempt_number_positive CHECK (attempt_number > 0)
    );
  `);

  // Failures are the minority on a healthy system, so a partial index stays small
  // and successful attempts cost nothing to maintain in it.
  pgm.sql(`
    CREATE INDEX delivery_attempts_recent_failures
      ON delivery_attempts (attempted_at DESC)
      WHERE status = 'failed';
  `);
}

/**
 * Destroys every row, which is the honest inverse of creating the schema but is
 * not a rollback anyone should reach for once this has run anywhere real.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TABLE IF EXISTS delivery_attempts;');
  pgm.sql('DROP TABLE IF EXISTS events;');
  pgm.sql('DROP TABLE IF EXISTS endpoints;');
}
