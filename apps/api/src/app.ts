import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { createPool } from '@conversaflow/database';
import { loadConfig, type Config } from './core/config';
import type { Deps } from './core/context';
import { MemoryMailer, SmtpMailer, type Mailer } from './core/mailer';
import { RateLimiter } from './core/rate-limit';
import { ClamdScanner, LocalStorage, SignatureScanner } from './core/storage';
import {
  AuditController, AuthController, BillingController, FilesController, HealthController, MeController, MembersController,
  PlatformController, SettingsController, TenantsController,
} from './http/controllers';
import { ErrorFilter } from './http/error-filter';
import { AccessGuard } from './http/guard';
import { requestLog, type LogSink } from './http/request-log';
import { DEPS } from './http/tokens';
import { AuditService } from './modules/audit.service';
import { AuthService } from './modules/auth.service';
import { EntitlementsService } from './modules/entitlements.service';
import { FilesService } from './modules/files.service';
import { MembersService } from './modules/members.service';
import { PlatformService } from './modules/platform.service';
import { SettingsService } from './modules/settings.service';
import { TenantsService } from './modules/tenants.service';

export function buildDeps(config: Config = loadConfig(), overrides: Partial<Deps> = {}): Deps {
  const redis = overrides.redis ?? new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
  if (!overrides.mailer && !config.SMTP_URL && config.NODE_ENV === 'production') {
    throw new Error('SMTP_URL is required in production: verification and reset emails must be delivered.');
  }
  const mailer: Mailer = overrides.mailer ?? (config.SMTP_URL ? new SmtpMailer(config.SMTP_URL) : new MemoryMailer());
  return {
    config,
    db: overrides.db ?? createPool(config.DATABASE_APP_URL),
    identityDb: overrides.identityDb ?? createPool(config.DATABASE_IDENTITY_URL, 5),
    platformDb: overrides.platformDb ?? createPool(config.DATABASE_PLATFORM_URL, 3),
    redis,
    rateLimiter: overrides.rateLimiter ?? new RateLimiter(redis),
    mailer,
    storage: overrides.storage ?? new LocalStorage(config.FILE_STORAGE_DIR),
    scanner:
      overrides.scanner ??
      (config.SCANNER === 'clamd'
        ? new ClamdScanner(config.CLAMD_HOST, config.CLAMD_PORT, {
            timeoutMs: config.CLAMD_TIMEOUT_MS,
            requireOfficialSignatures: config.SCANNER_REQUIRE_OFFICIAL_SIGNATURES,
            maxSignatureAgeHours: config.SCANNER_MAX_SIGNATURE_AGE_HOURS,
          })
        : new SignatureScanner()),
    keys: overrides.keys ?? {
      fileLinks: Buffer.from(config.FILE_URL_SIGNING_KEY, 'base64'),
      mfa: Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64'),
    },
  };
}

@Module({})
export class AppModule {
  static forRoot(deps: Deps): DynamicModule {
    const service = <T>(cls: new (d: Deps) => T) => ({ provide: cls, useFactory: () => new cls(deps) });
    return {
      module: AppModule,
      controllers: [
        HealthController, AuthController, MeController, TenantsController, MembersController, BillingController,
        AuditController, FilesController, SettingsController, PlatformController,
      ],
      providers: [
        { provide: DEPS, useValue: deps },
        service(AuthService), service(TenantsService), service(MembersService), service(EntitlementsService),
        service(AuditService), service(FilesService), service(SettingsService),
        { provide: PlatformService, useFactory: () => new PlatformService(deps.platformDb) },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}

export async function createApp(deps: Deps, opts: { logSink?: LogSink } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(deps), { logger: ['error', 'warn'] });
  app.use(requestLog(opts.logSink ?? (deps.config.NODE_ENV === 'test' ? () => undefined : undefined)));
  app.use(cookieParser());
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  await app.init();
  return app;
}
