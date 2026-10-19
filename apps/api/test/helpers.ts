import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';
import { createPool, withContext, type Db } from '@conversaflow/database';
import { buildDeps, createApp } from '../src/app';
import { loadConfig } from '../src/core/config';
import type { Deps } from '../src/core/context';
import { MemoryMailer } from '../src/core/mailer';
import { Notifier } from '../src/worker/notifier';

export const PASSWORD = 'Correct-Horse-Battery-9';

export interface TestApp {
  app: INestApplication;
  deps: Deps;
  mailer: MemoryMailer;
  /** Owner-role connection for test set-up only (the API never uses it). */
  ownerDb: Db;
  /** The notifier worker's connection (role cf_notify). */
  notifyDb: Db;
  /** Runs the notifier once, as the worker would, so queued account emails are sent. */
  deliver(): Promise<number>;
  close(): Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const mailer = new MemoryMailer();
  const deps = buildDeps(loadConfig(process.env), { mailer });
  const app = await createApp(deps);
  const ownerDb = createPool(process.env.DATABASE_URL!, 3);
  const notifyDb = createPool(process.env.DATABASE_NOTIFY_URL!, 2);
  const notifier = new Notifier(notifyDb, mailer, deps.config.APP_ORIGIN);
  return {
    app, deps, mailer, ownerDb, notifyDb,
    deliver: () => notifier.processPending(),
    async close() {
      await app.close();
      await deps.db.end();
      await deps.identityDb.end();
      await deps.platformDb.end();
      await ownerDb.end();
      await notifyDb.end();
      deps.redis.disconnect();
    },
  };
}

/** A browser-like client: keeps its cookie and sends the anti-forgery header on writes. */
export class Client {
  readonly agent;
  constructor(readonly t: TestApp, readonly email: string) {
    this.agent = request.agent(t.app.getHttpServer());
  }
  get(path: string) {
    return this.agent.get(path);
  }
  post(path: string, body?: object) {
    return this.agent.post(path).set('X-Requested-With', 'conversaflow').send(body ?? {});
  }
  put(path: string, body?: object) {
    return this.agent.put(path).set('X-Requested-With', 'conversaflow').send(body ?? {});
  }
  patch(path: string, body?: object) {
    return this.agent.patch(path).set('X-Requested-With', 'conversaflow').send(body ?? {});
  }
  delete(path: string) {
    return this.agent.delete(path).set('X-Requested-With', 'conversaflow');
  }
  upload(name: string, contentType: string, data: Buffer) {
    return this.agent.post('/v1/files').set('X-Requested-With', 'conversaflow').attach('file', data, { filename: name, contentType });
  }
  /** Set after enableMfa(). */
  mfaSecret?: string;
  userId?: string;
  /** The session cookie (name=value) from sign-in. */
  cookie?: string;
}

export const uniqueEmail = (label: string) => `${label}.${randomBytes(4).toString('hex')}@example.test`;
export const uniqueSlug = (label: string) => `${label}-${randomBytes(3).toString('hex')}`;

/** Delivers queued account emails (as the worker would), then reads the newest token sent to `to`. */
export async function tokenFrom(t: TestApp, to: string): Promise<string> {
  await t.deliver();
  const mail = t.mailer.lastTo(to);
  const match = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No token mailed to ${to}`);
  return match[1]!;
}

/** Rate limits are real (Redis); tests that create many users clear them first. */
export const clearRateLimits = (t: TestApp) => t.deps.redis.flushdb();

/** Signs up, verifies the email and signs in. */
export async function newUser(t: TestApp, label: string): Promise<Client> {
  const c = new Client(t, uniqueEmail(label));
  await clearRateLimits(t);
  await c.post('/v1/auth/signup', { email: c.email, password: PASSWORD, fullName: `Test ${label}` }).expect(202);
  await c.post('/v1/auth/verify-email', { token: await tokenFrom(t, c.email) }).expect(204);
  const login = await c.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
  c.cookie = String(login.headers['set-cookie']).split(';')[0];
  c.userId = (await c.get('/v1/me').expect(200)).body.id;
  return c;
}

export async function enableMfa(c: Client): Promise<void> {
  const setup = await c.post('/v1/auth/mfa/totp/setup').expect(201);
  c.mfaSecret = setup.body.secret;
  await c.post('/v1/auth/mfa/totp/confirm', { code: authenticator.generate(c.mfaSecret!) }).expect(201);
}

export async function newCompany(c: Client, label: string, planCode = 'starter'): Promise<string> {
  const res = await c.post('/v1/tenants', {
    legalName: `${label} Trading LLC`, slug: uniqueSlug(label), country: 'AE', timezone: 'Asia/Dubai', currency: 'AED', planCode,
  }).expect(201);
  return res.body.id;
}

/** Owner invites `email` with `roleKey`; returns the emailed token. Owner must have MFA. */
export async function invite(t: TestApp, owner: Client, email: string, roleKey: string): Promise<string> {
  await owner.post('/v1/invitations', { email, roleKey }).expect(201);
  return await tokenFrom(t, email);
}

/** Creates a user and adds them to the owner's active company with the given role. */
export async function addMember(t: TestApp, owner: Client, label: string, roleKey: string): Promise<Client> {
  const member = await newUser(t, label);
  const token = await invite(t, owner, member.email, roleKey);
  await member.post('/v1/invitations/accept', { token }).expect(201);
  return member;
}

/** Runs SQL as the owner role inside a company context (RLS is forced for the owner too). */
export function asOwner<T>(t: TestApp, tenantId: string | null, fn: Parameters<typeof withContext<T>>[2]) {
  return withContext(t.ownerDb, { tenantId, userId: null }, fn);
}

/** A code from a fresh 30-second step (each step's code is accepted only once). */
export async function nextTotp(c: Client): Promise<string> {
  const step = () => Math.floor(Date.now() / 30000);
  const start = step();
  while (step() === start) await new Promise((r) => setTimeout(r, 250));
  return authenticator.generate(c.mfaSecret!);
}

/** Ends the trial for a company (platform operation, owner role) so plan limits apply without trial caps. */
export async function activateSubscription(t: TestApp, tenantId: string): Promise<void> {
  await asOwner(t, tenantId, (tx) => tx.query("UPDATE subscriptions SET status = 'active', trial_ends_at = NULL WHERE tenant_id = $1", [tenantId]));
}

/** Creates platform staff (added by the owner role, as in the operations runbook), signed in with MFA. */
export async function newStaff(t: TestApp, label: string, role: 'platform_owner' | 'support_agent'): Promise<Client> {
  const c = await newUser(t, label);
  await t.ownerDb.query("INSERT INTO platform_staff (user_id, role, added_by) VALUES ($1, $2, 'test-runbook')", [c.userId, role]);
  await enableMfa(c);
  return c;
}
