import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createDeliveryAgent } from './delivery/client.js';
import { createDeliveryQueue, enqueueDelivery } from './delivery/queue.js';
import { createDeliveryWorker } from './delivery/worker.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = createPool(config);
const queue = createDeliveryQueue(config.REDIS_URL);
const agent = createDeliveryAgent({
  allowPrivateAddresses: config.ALLOW_PRIVATE_DESTINATIONS,
});

const app = buildServer({
  config,
  db,
  onAccepted: async (eventId) => enqueueDelivery(queue, { eventId, attempt: 1 }),
});

const worker = createDeliveryWorker(
  { db, agent, queue },
  { redisUrl: config.REDIS_URL, concurrency: config.WORKER_CONCURRENCY },
);

if (config.ALLOW_PRIVATE_DESTINATIONS) {
  app.log.warn(
    'ALLOW_PRIVATE_DESTINATIONS is on: deliveries may reach loopback, private and cloud metadata addresses',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    // The worker closes first so in-flight deliveries finish before the pool
    // they need is torn down.
    Promise.resolve()
      .then(() => worker.close())
      .then(() => app.close())
      .then(() => queue.close())
      .then(() => agent.close())
      .then(() => db.end())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error(err);
          process.exit(1);
        },
      );
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
