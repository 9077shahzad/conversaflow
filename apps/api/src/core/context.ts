import type { AiProvider } from '../modules/ai-provider';
import type Redis from 'ioredis';
import type { Db } from '@conversaflow/database';
import type { Config } from './config';
import type { Mailer } from './mailer';
import type { RateLimiter } from './rate-limit';
import type { PushSender } from '../modules/push';
import type { FileScanner, ObjectStorage } from './storage';
import type { ChannelAdapter, Provider } from '../modules/channels';

/** Everything a service needs, built once at start-up (and by tests with fakes where useful). */
export interface Deps {
  config: Config;
  /** cf_app: business data. Has no rights over credentials. */
  db: Db;
  /** cf_identity: sign-in, sessions and MFA only. */
  identityDb: Db;
  /** cf_platform: platform owner console only. */
  platformDb: Db;
  redis: Redis;
  rateLimiter: RateLimiter;
  mailer: Mailer;
  storage: ObjectStorage;
  scanner: FileScanner;
  keys: { fileLinks: Buffer; sandboxWebhook: string; sandboxVerifyToken: string; webhookSecrets: Buffer };
  /** Messaging adapters by provider. Only those configured here can send. */
  channels: Partial<Record<Provider, ChannelAdapter>>;
  /** The AI provider (simulated unless an AI account is configured). */
  ai: AiProvider;
  /** Web push sender (records only, unless VAPID keys are configured). */
  push: PushSender;
}

/** The signed-in session, resolved from the cookie on every request. */
export interface AuthSession {
  /** The cookie value. Held in memory for this request only, so privileged database actions can be bound to it. */
  token: string;
  sessionId: string;
  userId: string;
  activeTenantId: string | null;
  mfaVerified: boolean;
  userHasMfa: boolean;
}

/** A request acting inside one company. Built only after membership has been checked. */
export interface TenantActor {
  /** Set when the request came through the public API with this key (W2.8). */
  apiKeyId?: string;
  tenantId: string;
  userId: string;
  membershipId: string;
  roles: string[];
  permissions: Set<string>;
  /** Pilot companies require two-step sign-in for every member (migration 0011). */
  requiresMfa: boolean;
  ip?: string;
}
