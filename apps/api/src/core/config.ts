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
  /** Seals outgoing-webhook signing secrets in the database (AES-256-GCM); the API and the worker need the same key. */
  WEBHOOK_SECRETS_KEY: key32,
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
  /** Uploads are refused unless clamd has the official signature database loaded and it is recent. */
  SCANNER_REQUIRE_OFFICIAL_SIGNATURES: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  SCANNER_MAX_SIGNATURE_AGE_HOURS: z.coerce.number().int().min(1).max(168).default(48),
  /**
   * Sandbox messaging channel (local test double; never contacts a provider). Off unless set; development and test
   * turn it on by default (review note), and production refuses it.
   */
  CHANNEL_SANDBOX_ENABLED: z.enum(['true', 'false']).optional(),
  /**
   * Where incoming webhook events are applied (AX-3). `worker` (the default in production): the request records them
   * and answers at once; the worker applies them. `request`: applied in the same request after recording, through the
   * same code; for development and the test suite only, refused in production. Default: worker in production,
   * request elsewhere.
   */
  INBOUND_APPLY: z.enum(['worker', 'request']).optional(),
  /**
   * AI provider (Wave 2). `simulated` (the default): a deterministic, clearly labelled stand-in that quotes the
   * company's knowledge only. `anthropic`: the Anthropic API with AI_API_KEY; not used until the owner approves an AI
   * account. Prices are per million tokens, for the budget; the simulated provider costs nothing.
   */
  AI_PROVIDER: z.enum(['simulated', 'anthropic']).default('simulated'),
  AI_API_KEY: z.string().min(20).optional(),
  AI_MODEL: z.string().min(3).max(100).default('claude-sonnet-5-5'),
  AI_PRICE_INPUT_PER_MTOK_USD: z.coerce.number().min(0).max(1000).optional(),
  AI_PRICE_OUTPUT_PER_MTOK_USD: z.coerce.number().min(0).max(1000).optional(),
  /**
   * Web push (W2.5): the VAPID key pair (base64url) and a contact address for push services. Without them,
   * notifications are recorded but sent nowhere, and the screen says so.
   */
  VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/).optional(),
  VAPID_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9_-]{40,50}$/).optional(),
  /** Development and tests only: lets outgoing webhooks reach private addresses (never in production). */
  WEBHOOKS_ALLOW_PRIVATE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/).default('mailto:support@conversaflow.io'),
  /**
   * Payment provider for prepaid message-credit top-ups (migration 0061). `test`: a clearly labelled stand-in where
   * no money moves (default outside production; refused in production). `none`: top-ups are unavailable. A real
   * provider is added only after the owner approves the payment account.
   */
  CREDITS_PROVIDER: z.enum(['none', 'test']).optional(),
  /** Secret used to sign sandbox webhooks (HMAC-SHA256, Meta's scheme). Generated per process when not set. */
  SANDBOX_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Token echoed during webhook verification (hub.verify_token). Generated per process when not set. */
  SANDBOX_VERIFY_TOKEN: z.string().min(16).optional(),
});

export type Config = Omit<z.infer<typeof Schema>, 'CHANNEL_SANDBOX_ENABLED' | 'INBOUND_APPLY' | 'CREDITS_PROVIDER'>
  & { CHANNEL_SANDBOX_ENABLED: boolean; INBOUND_APPLY: 'worker' | 'request'; CREDITS_PROVIDER: 'none' | 'test' };

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
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.SCANNER_REQUIRE_OFFICIAL_SIGNATURES) {
    throw new Error('Invalid configuration: production requires SCANNER_REQUIRE_OFFICIAL_SIGNATURES=true.');
  }
  const sandbox = parsed.data.CHANNEL_SANDBOX_ENABLED === undefined
    ? parsed.data.NODE_ENV !== 'production'
    : parsed.data.CHANNEL_SANDBOX_ENABLED === 'true';
  if (parsed.data.NODE_ENV === 'production' && sandbox) {
    throw new Error('Invalid configuration: production requires CHANNEL_SANDBOX_ENABLED=false (the sandbox channel is a test double).');
  }
  if (parsed.data.AI_PROVIDER === 'anthropic' && (!parsed.data.AI_API_KEY || parsed.data.AI_PRICE_INPUT_PER_MTOK_USD === undefined || parsed.data.AI_PRICE_OUTPUT_PER_MTOK_USD === undefined)) {
    throw new Error('Invalid configuration: AI_PROVIDER=anthropic needs AI_API_KEY and both AI prices (so budgets are enforced).');
  }
  const inbound = parsed.data.INBOUND_APPLY ?? (parsed.data.NODE_ENV === 'production' ? 'worker' : 'request');
  if (parsed.data.NODE_ENV === 'production' && inbound !== 'worker') {
    throw new Error('Invalid configuration: production requires INBOUND_APPLY=worker (incoming events are applied by the worker).');
  }
  const credits = parsed.data.CREDITS_PROVIDER ?? (parsed.data.NODE_ENV === 'production' ? 'none' : 'test');
  if (parsed.data.NODE_ENV === 'production' && credits === 'test') {
    throw new Error('Invalid configuration: production refuses CREDITS_PROVIDER=test (the test payment provider moves no money).');
  }
  return { ...parsed.data, CHANNEL_SANDBOX_ENABLED: sandbox, INBOUND_APPLY: inbound, CREDITS_PROVIDER: credits };
}
