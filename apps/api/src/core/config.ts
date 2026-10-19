import { z } from 'zod';

const key32 = z
  .string()
  .min(1, 'is required')
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded');

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_APP_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  FILE_URL_SIGNING_KEY: key32,
  MFA_ENCRYPTION_KEY: key32,
  FILE_STORAGE_DIR: z.string().min(1),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  SMTP_URL: z.string().optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(16 * 1024 * 1024),
});

export type Config = z.infer<typeof Schema>;

/** Reads configuration from the environment and refuses to start when anything required is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
