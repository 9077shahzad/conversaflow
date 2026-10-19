import type Redis from 'ioredis';
import type { Db } from '@conversaflow/database';
import type { Config } from './config';
import type { Mailer } from './mailer';
import type { RateLimiter } from './rate-limit';
import type { FileScanner, ObjectStorage } from './storage';

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
  keys: { fileLinks: Buffer; mfa: Buffer };
}

/** The signed-in session, resolved from the cookie on every request. */
export interface AuthSession {
  sessionId: string;
  userId: string;
  activeTenantId: string | null;
  mfaVerified: boolean;
  userHasMfa: boolean;
}

/** A request acting inside one company. Built only after membership has been checked. */
export interface TenantActor {
  tenantId: string;
  userId: string;
  membershipId: string;
  roles: string[];
  permissions: Set<string>;
  ip?: string;
}
