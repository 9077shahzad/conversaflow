/**
 * Worker process (same codebase as the API, separate process and database credentials — ADR-001).
 * Jobs: account emails (Notifier, role cf_notify); incoming webhook events recorded by the API (InboundProcessor,
 * leased through inbound_claim, AX-3); outbound messages (Sender, role cf_app inside each company's
 * context, leased through dispatch_claim); inbound media downloads (MediaFetcher, leased through media_claim, each
 * file checked for malware before it is stored). Sending recovers by itself: an expired lease is picked up again, and a
 * message that may already have reached the provider becomes 'uncertain' instead of being sent twice.
 */
import { createPool } from '@conversaflow/database';
import { z } from 'zod';
import { MemoryMailer, SmtpMailer } from './core/mailer';
import { Notifier } from './worker/notifier';
import { SandboxAdapter, type ChannelAdapter, type Provider } from './modules/channels';
import { Sender } from './modules/sender';
import { MediaFetcher } from './modules/media';
import { CampaignRunner } from './modules/campaigns';
import { InboundProcessor } from './modules/inbound';
import { AutomationRunner } from './modules/automations';
import { AiService } from './modules/ai';
import { AnthropicProvider, SimulatedAiProvider } from './modules/ai-provider';
import type { Deps } from './core/context';
import { AutomationMetering } from './modules/entitlements.service';
import { ContactImportService } from './modules/contacts-import';
import { ClamdScanner, LocalStorage, SignatureScanner } from './core/storage';

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_NOTIFY_URL: z.string().url(),
    SMTP_URL: z.string().optional(),
    APP_ORIGIN: z.string().url().default('http://localhost:3000'),
    NOTIFY_POLL_MS: z.coerce.number().int().min(250).default(2000),
    /** Business-role connection, used to process send jobs inside each company's context. */
    DATABASE_APP_URL: z.string().url(),
    SEND_POLL_MS: z.coerce.number().int().min(250).default(1000),
    CHANNEL_SANDBOX_ENABLED: z.enum(['true', 'false']).optional(),
    FILE_STORAGE_DIR: z.string().min(1),
    MAX_UPLOAD_BYTES: z.coerce.number().int().default(16 * 1024 * 1024),
    SCANNER: z.enum(['clamd', 'signature']).default('clamd'),
    CLAMD_HOST: z.string().default('127.0.0.1'),
    CLAMD_PORT: z.coerce.number().int().default(3310),
    CLAMD_TIMEOUT_MS: z.coerce.number().int().default(15_000),
    SCANNER_REQUIRE_OFFICIAL_SIGNATURES: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    SCANNER_MAX_SIGNATURE_AGE_HOURS: z.coerce.number().int().min(1).max(168).default(48),
    MEDIA_POLL_MS: z.coerce.number().int().min(250).default(2000),
    INBOUND_POLL_MS: z.coerce.number().int().min(100).default(500),
    AI_PROVIDER: z.enum(['simulated', 'anthropic']).default('simulated'),
    AI_API_KEY: z.string().min(20).optional(),
    AI_MODEL: z.string().min(3).max(100).default('claude-sonnet-5-5'),
    AI_PRICE_INPUT_PER_MTOK_USD: z.coerce.number().min(0).max(1000).optional(),
    AI_PRICE_OUTPUT_PER_MTOK_USD: z.coerce.number().min(0).max(1000).optional(),
  })
  .parse(process.env);

if (env.AI_PROVIDER === 'anthropic' && (!env.AI_API_KEY || env.AI_PRICE_INPUT_PER_MTOK_USD === undefined || env.AI_PRICE_OUTPUT_PER_MTOK_USD === undefined)) {
  throw new Error('AI_PROVIDER=anthropic needs AI_API_KEY and both AI prices.');
}
if (env.NODE_ENV === 'production' && !env.SMTP_URL) throw new Error('SMTP_URL is required in production.');
if (env.NODE_ENV === 'production' && (env.SCANNER !== 'clamd' || !env.SCANNER_REQUIRE_OFFICIAL_SIGNATURES)) {
  throw new Error('Production requires SCANNER=clamd with official signatures.');
}

const notifier = new Notifier(
  createPool(env.DATABASE_NOTIFY_URL, 2),
  env.SMTP_URL ? new SmtpMailer(env.SMTP_URL) : new MemoryMailer(),
  env.APP_ORIGIN,
);

const sandboxOn = env.CHANNEL_SANDBOX_ENABLED === undefined ? env.NODE_ENV !== 'production' : env.CHANNEL_SANDBOX_ENABLED === 'true';
if (env.NODE_ENV === 'production' && sandboxOn) throw new Error('Production requires CHANNEL_SANDBOX_ENABLED=false.');
const channels: Partial<Record<Provider, ChannelAdapter>> = sandboxOn ? { sandbox: new SandboxAdapter() } : {};
const appDb = createPool(env.DATABASE_APP_URL, 4);
const storage = new LocalStorage(env.FILE_STORAGE_DIR);
const scanner = env.SCANNER === 'clamd'
  ? new ClamdScanner(env.CLAMD_HOST, env.CLAMD_PORT, {
      timeoutMs: env.CLAMD_TIMEOUT_MS, requireOfficialSignatures: env.SCANNER_REQUIRE_OFFICIAL_SIGNATURES,
      maxSignatureAgeHours: env.SCANNER_MAX_SIGNATURE_AGE_HOURS,
    })
  : new SignatureScanner();
const sender = new Sender(appDb, channels, {}, undefined, storage);
const media = new MediaFetcher(appDb, channels, storage, scanner, env.MAX_UPLOAD_BYTES);
const campaigns = new CampaignRunner(appDb);
const inbound = new InboundProcessor(appDb);
// AI for the "AI reply" automation step: the same configuration as the API (simulated unless an AI account is set up).
const aiService = new AiService({ db: appDb, config: { NODE_ENV: env.NODE_ENV, AI_PRICE_INPUT_PER_MTOK_USD: env.AI_PRICE_INPUT_PER_MTOK_USD, AI_PRICE_OUTPUT_PER_MTOK_USD: env.AI_PRICE_OUTPUT_PER_MTOK_USD } } as unknown as Deps,
  env.AI_PROVIDER === 'anthropic' ? new AnthropicProvider(env.AI_API_KEY!, env.AI_MODEL) : new SimulatedAiProvider());
const automations = new AutomationRunner(appDb, new AutomationMetering({ db: appDb }), aiService);

let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

(async () => {
  console.log('ConversaFlow worker started: account emails, incoming events, automations, outbound messages, inbound media, campaigns, import preview expiry');
  void (async () => {
    while (!stopping) {
      try {
        while ((await campaigns.dispatchDue(5)) > 0 && !stopping) { /* drain due batches */ }
      } catch (err) {
        console.error('campaign error', err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, env.MEDIA_POLL_MS));
    }
  })();
  // Incoming webhook events recorded by the API: applied here (AX-3).
  void (async () => {
    while (!stopping) {
      try {
        while ((await inbound.dispatchDue(200)) > 0 && !stopping) { /* drain */ }
      } catch (err) {
        console.error('inbound error', err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, env.INBOUND_POLL_MS));
    }
  })();
  // Automation runs (W2.1): started by incoming messages, carried out step by step.
  void (async () => {
    while (!stopping) {
      try {
        while ((await automations.dispatchDue(50)) > 0 && !stopping) { /* drain */ }
      } catch (err) {
        console.error('automation error', err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, env.INBOUND_POLL_MS));
    }
  })();
  // Contact import previews that were never imported: names and numbers are cleared after a day (checked hourly).
  void (async () => {
    while (!stopping) {
      try {
        while ((await ContactImportService.expirePreviews(appDb, 200)) > 0 && !stopping) { /* drain */ }
      } catch (err) {
        console.error('import preview expiry error', err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, 3600_000));
    }
  })();
  void (async () => {
    while (!stopping) {
      try {
        while ((await media.dispatchDue(10)) > 0 && !stopping) { /* drain */ }
      } catch (err) {
        console.error('media error', err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, env.MEDIA_POLL_MS));
    }
  })();
  void (async () => {
    while (!stopping) {
      try {
        while ((await sender.dispatchDue(20)) > 0 && !stopping) { /* drain */ }
      } catch (err) {
        console.error('sender error', err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, env.SEND_POLL_MS));
    }
  })();
  while (!stopping) {
    try {
      await notifier.processPending();
    } catch (err) {
      console.error('notifier error', err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, env.NOTIFY_POLL_MS));
  }
  process.exit(0);
})();
