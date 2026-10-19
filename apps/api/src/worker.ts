/**
 * Worker process (same codebase as the API, separate process and database credentials — ADR-001).
 * Milestone 1.x jobs: account emails (Notifier, role cf_notify).
 */
import { createPool } from '@conversaflow/database';
import { z } from 'zod';
import { MemoryMailer, SmtpMailer } from './core/mailer';
import { Notifier } from './worker/notifier';

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_NOTIFY_URL: z.string().url(),
    SMTP_URL: z.string().optional(),
    APP_ORIGIN: z.string().url().default('http://localhost:3000'),
    NOTIFY_POLL_MS: z.coerce.number().int().min(250).default(2000),
  })
  .parse(process.env);

if (env.NODE_ENV === 'production' && !env.SMTP_URL) throw new Error('SMTP_URL is required in production.');

const notifier = new Notifier(
  createPool(env.DATABASE_NOTIFY_URL, 2),
  env.SMTP_URL ? new SmtpMailer(env.SMTP_URL) : new MemoryMailer(),
  env.APP_ORIGIN,
);

let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

(async () => {
  console.log('ConversaFlow worker started: account emails');
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
