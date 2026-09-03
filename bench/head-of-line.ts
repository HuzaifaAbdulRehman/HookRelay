import {
  type Relay,
  createEndpoint,
  deliver,
  percentiles,
  sleep,
  startDestination,
  table,
} from './harness.js';

const NOISY_EVENTS = Number(process.env.NOISY_EVENTS ?? 40);
const QUIET_EVENTS = 5;
const RUNS = Number(process.env.RUNS ?? 3);
const PATIENCE_MS = 90_000;

/**
 * Does one dead destination starve everybody else?
 *
 * A worker slot is held for the whole delivery timeout when a destination
 * accepts a connection and never answers. With a shared queue and a fixed
 * concurrency, enough hanging deliveries occupy every slot, and an unrelated
 * endpoint waits behind them.
 *
 * The measurement is time from accepting a webhook on the quiet endpoint to the
 * quiet destination actually receiving it, with and without a noisy neighbour.
 */
async function runOnce(relay: Relay, withNeighbour: boolean, run: number): Promise<number[]> {
  const noisy = await startDestination('hang');
  const quiet = await startDestination('ok');

  const noisyEndpoint = await createEndpoint(relay, `hol-noisy-${run}-${Date.now()}`, noisy.url);
  const quietEndpoint = await createEndpoint(relay, `hol-quiet-${run}-${Date.now()}`, quiet.url);

  if (withNeighbour) {
    for (let i = 0; i < NOISY_EVENTS; i += 1) {
      await deliver(noisyEndpoint.ingest, noisyEndpoint.secret, `noisy-${run}-${i}`);
    }
    // Give the worker a moment to pick the hanging deliveries up and fill its slots.
    await sleep(1_000);
  }

  const sentAt: number[] = [];
  for (let i = 0; i < QUIET_EVENTS; i += 1) {
    await deliver(quietEndpoint.ingest, quietEndpoint.secret, `quiet-${run}-${i}`);
    sentAt.push(Date.now());
  }

  const deadline = Date.now() + PATIENCE_MS;
  while (quiet.hits() < QUIET_EVENTS && Date.now() < deadline) {
    await sleep(100);
  }
  const arrived = Date.now();

  const delivered = quiet.hits();
  await noisy.close();
  await quiet.close();

  if (delivered < QUIET_EVENTS) {
    throw new Error(`only ${delivered}/${QUIET_EVENTS} quiet events arrived within ${PATIENCE_MS}ms`);
  }

  // All five are measured against the last arrival, so this is the time for the
  // quiet endpoint to drain rather than a per-event figure.
  return sentAt.map((sent) => arrived - sent);
}

async function main(): Promise<void> {
  const relay: Relay = {
    base: process.env.RELAY_BASE ?? 'http://localhost:3000',
    apiKey: process.env.API_KEY ?? '',
  };
  if (relay.apiKey === '') throw new Error('API_KEY must be set');

  const rows: Record<string, string | number>[] = [];

  for (const withNeighbour of [false, true]) {
    for (let run = 0; run < RUNS; run += 1) {
      const samples = await runOnce(relay, withNeighbour, run);
      const p = percentiles(samples);
      rows.push({
        'noisy neighbour': withNeighbour ? `yes (${NOISY_EVENTS} hanging)` : 'no',
        run: run + 1,
        'p50 ms': p.p50,
        'p95 ms': p.p95,
        'max ms': p.max,
      });
      await sleep(2_000);
    }
  }

  console.log(`\n### Time to deliver ${QUIET_EVENTS} events on a healthy endpoint\n`);
  console.log(table(rows));
}

await main();
