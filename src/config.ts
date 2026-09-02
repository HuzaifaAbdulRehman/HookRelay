import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /**
   * GitHub caps payloads at 25 MB, but the raw body is held in memory to be
   * hashed, so accepting that much means anyone holding an ingest URL can make
   * us allocate 25 MB per request. 5 MB covers ordinary deliveries and rejects
   * the rare enormous push event, which is the trade worth making.
   */
  INGEST_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Reads and validates the environment. Throws on the first boot rather than
 * failing later on the request that happens to need a missing value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }

  return parsed.data;
}
