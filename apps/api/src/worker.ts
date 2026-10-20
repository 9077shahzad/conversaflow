/**
 * Worker process (same codebase as the API, separate process and database credentials — ADR-001).
 * Jobs: account emails (Notifier, role cf_notify); outbound messages (Sender, role cf_app inside each company's
 * context, leased through dispatch_claim). Sending recovers by itself: an expired lease is picked up again, and a
 * message that may already have reached the provider becomes 'uncertain' instead of being sent twice.
 */
import { createPool } from '@conversaflow/database';
import { z } from 'zod';
import { MemoryMailer, SmtpMailer } from './core/mailer';
import { Notifier } from './worker/notifier';
import { SandboxAdapter, type ChannelAdapter, type Provider } from './modules/channels';
import { Sender } from './modules/sender';

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
  })
  .parse(process.env);

if (env.NODE_ENV === 'production' && !env.SMTP_URL) throw new Error('SMTP_URL is required in production.');

const notifier = new Notifier(
  createPool(env.DATABASE_NOTIFY_URL, 2),
  env.SMTP_URL ? new SmtpMailer(env.SMTP_URL) : new MemoryMailer(),
  env.APP_ORIGIN,
);

const sandboxOn = env.CHANNEL_SANDBOX_ENABLED === undefined ? env.NODE_ENV !== 'production' : env.CHANNEL_SANDBOX_ENABLED === 'true';
if (env.NODE_ENV === 'production' && sandboxOn) throw new Error('Production requires CHANNEL_SANDBOX_ENABLED=false.');
const channels: Partial<Record<Provider, ChannelAdapter>> = sandboxOn ? { sandbox: new SandboxAdapter() } : {};
const sender = new Sender(createPool(env.DATABASE_APP_URL, 4), channels);

let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

(async () => {
  console.log('ConversaFlow worker started: account emails, outbound messages');
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
