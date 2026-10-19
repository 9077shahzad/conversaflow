import { z } from 'zod';

const key32 = z
  .string()
  .min(1, 'is required')
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded');

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_APP_URL: z.string().url(),
  /** Separate connection for sign-in, sessions and MFA (role cf_identity). */
  DATABASE_IDENTITY_URL: z.string().url(),
  /** Platform owner console connection (role cf_platform). */
  DATABASE_PLATFORM_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  FILE_URL_SIGNING_KEY: key32,
  MFA_ENCRYPTION_KEY: key32,
  FILE_STORAGE_DIR: z.string().min(1),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  SMTP_URL: z.string().optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(16 * 1024 * 1024),
  /** A session unused for this long is ended (5–1440 minutes). */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** A session ends this long after sign-in, however active (1–168 hours). */
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  /** Malware scanner: 'clamd' (ClamAV daemon) everywhere; 'signature' is a test double, refused in production. */
  SCANNER: z.enum(['clamd', 'signature']).default('clamd'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().default(3310),
  CLAMD_TIMEOUT_MS: z.coerce.number().int().default(15_000),
});

export type Config = z.infer<typeof Schema>;

/** Reads configuration from the environment and refuses to start when anything required is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.SCANNER !== 'clamd') {
    throw new Error('Invalid configuration: production requires SCANNER=clamd (the signature scanner is a test double).');
  }
  return parsed.data;
}
