import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { createPool } from '@conversaflow/database';
import { loadConfig, type Config } from './core/config';
import type { Deps } from './core/context';
import { MemoryMailer, SmtpMailer, type Mailer } from './core/mailer';
import { RateLimiter } from './core/rate-limit';
import { ClamdScanner, LocalStorage, SignatureScanner } from './core/storage';
import {
  AuditController, AuthController, BillingController, ChannelsController, FilesController, HealthController, InboxController,
  MeController, MembersController, MessagesController, PlatformController, SettingsController, TenantsController, WebhooksController,
  TemplatesController, ContactsController, CampaignsController, SuppressionsController,
  TagsController, ConversationTagsController, SavedRepliesController, AssignmentController, ReportsController, AutomationsController, AutomationRunsController, AiController, KnowledgeController,
  CustomerPortalController, CustomerLinksController, NotificationsController, PromisesController, PublicApiController, DevelopersController, SetupController,
} from './http/controllers';
import { ErrorFilter } from './http/error-filter';
import { AccessGuard } from './http/guard';
import { requestLog, type LogSink } from './http/request-log';
import { DEPS } from './http/tokens';
import { AuditService } from './modules/audit.service';
import { AuthService } from './modules/auth.service';
import { EntitlementsService } from './modules/entitlements.service';
import { FilesService } from './modules/files.service';
import { SandboxAdapter } from './modules/channels';
import { InboxService } from './modules/inbox.service';
import { TemplatesService } from './modules/templates.service';
import { HealthService } from './modules/health.service';
import { CampaignsService } from './modules/campaigns';
import { SavedRepliesService, TagsService } from './modules/inbox-tools';
import { ContactImportService } from './modules/contacts-import';
import { AssignmentService } from './modules/auto-assign';
import { ReportsService } from './modules/reports';
import { AutomationsService } from './modules/automations';
import { AnthropicProvider, SimulatedAiProvider } from './modules/ai-provider';
import { AiService } from './modules/ai';
import { PushService, RecordingPushSender, WebPushSender } from './modules/push';
import { PromisesService } from './modules/promises';
import { SetupService } from './modules/setup';
import { OutcomesService } from './modules/outcomes';
import { ApiAuth, ApiKeysService, PublicApiReads, WebhookEndpointsService } from './modules/public-api';
import { CustomerLinksService, CustomerPortalService } from './modules/customer-links';
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
      webhookSecrets: Buffer.from(config.WEBHOOK_SECRETS_KEY, 'base64'),
      sandboxWebhook: config.SANDBOX_WEBHOOK_SECRET ?? randomBytes(32).toString('hex'),
      sandboxVerifyToken: config.SANDBOX_VERIFY_TOKEN ?? randomBytes(24).toString('hex'),
    },
    channels: overrides.channels ?? (config.CHANNEL_SANDBOX_ENABLED ? { sandbox: new SandboxAdapter() } : {}),
    ai: overrides.ai ?? (config.AI_PROVIDER === 'anthropic' ? new AnthropicProvider(config.AI_API_KEY!, config.AI_MODEL) : new SimulatedAiProvider()),
    push: overrides.push ?? (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
      ? new WebPushSender({ publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: config.VAPID_SUBJECT })
      : new RecordingPushSender()),
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
        AuditController, FilesController, SettingsController, PlatformController, ChannelsController, WebhooksController,
        InboxController, MessagesController, TemplatesController, ContactsController, CampaignsController, SuppressionsController,
        TagsController, ConversationTagsController, SavedRepliesController, AssignmentController, ReportsController, AutomationsController, AutomationRunsController, AiController, KnowledgeController,
        CustomerPortalController, CustomerLinksController, NotificationsController, PromisesController, PublicApiController, DevelopersController, SetupController,
      ],
      providers: [
        { provide: DEPS, useValue: deps },
        service(AuthService), service(TenantsService), service(MembersService), service(EntitlementsService),
        service(AuditService), service(FilesService), service(SettingsService), service(InboxService), service(TemplatesService), service(HealthService), service(CampaignsService),
        service(TagsService), service(SavedRepliesService), service(ContactImportService), service(AssignmentService), service(ReportsService), service(AutomationsService), service(CustomerLinksService), service(CustomerPortalService), service(PromisesService), service(SetupService), service(OutcomesService), service(ApiAuth), service(ApiKeysService), service(PublicApiReads), service(WebhookEndpointsService), { provide: PushService, useFactory: () => new PushService({ db: deps.db, config: deps.config, rateLimiter: deps.rateLimiter }, deps.push) }, { provide: AiService, useFactory: () => new AiService(deps, deps.ai) },
        { provide: PlatformService, useFactory: () => new PlatformService(deps.platformDb) },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}

export async function createApp(deps: Deps, opts: { logSink?: LogSink } = {}): Promise<INestApplication> {
  // rawBody: webhook signatures are checked over the exact bytes received (CF-EXT-001).
  const app = await NestFactory.create(AppModule.forRoot(deps), { logger: ['error', 'warn'], rawBody: true });
  app.use(requestLog(opts.logSink ?? (deps.config.NODE_ENV === 'test' ? () => undefined : undefined)));
  app.use(cookieParser());
  // Provider webhooks may carry up to about 3 MB (Meta's documented maximum); every other JSON body keeps the default
  // limit. The raw bytes are kept for the signature check. Larger bodies get 413, not a server error (review M4).
  // Wrapped in a named function: Nest skips its own JSON parser when it finds a middleware called "jsonParser".
  const webhookJson = json({
    limit: '3mb',
    verify: (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody?: Buffer }).rawBody = buf; },
  });
  app.use('/v1/webhooks', function webhookBodyParser(req: never, res: never, next: never) { webhookJson(req, res, next); });
  // Contact import previews carry the CSV itself: up to 2 MB of text, which grows when JSON-escaped (review H1).
  const importJson = json({ limit: '5mb' });
  app.use('/v1/contacts/imports', function importBodyParser(req: never, res: never, next: never) { importJson(req, res, next); });
  // API responses are data, never pages: nothing in them may run, be framed or be sniffed (ADR-028, review F3).
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  await app.init();
  return app;
}
