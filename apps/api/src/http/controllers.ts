/// <reference types="multer" />
import { OperatorService, QuotePortalService, QUOTE_LINK_HEADER } from '../modules/operator';
import { CreditsService } from '../modules/credits';
import { webhookTokenOk } from '../modules/dialog360';
import { SetupService } from '../modules/setup';
import { OutcomesService } from '../modules/outcomes';
import { ApiAuth, ApiKeysService, PublicApiReads, requireScope, WebhookEndpointsService, type ApiCaller } from '../modules/public-api';
import { PromisesService } from '../modules/promises';
import { PushService } from '../modules/push';
import { CustomerLinksService, CustomerPortalService, LINK_HEADER } from '../modules/customer-links';
import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { MfaChallengeRequest, MfaConfirmRequest, VerifyEmailRequest } from '@conversaflow/contracts';
import type { AuthSession, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { z } from 'zod';

const MfaActivateRequest = z.object({ code: z.string().trim().min(8).max(20) });
import { AuditService } from '../modules/audit.service';
import { AuthService, type ClientInfo } from '../modules/auth.service';
import { EntitlementsService } from '../modules/entitlements.service';
import { FilesService } from '../modules/files.service';
import { isUuid, MembersService } from '../modules/members.service';
import { PlatformService } from '../modules/platform.service';
import { SettingsService } from '../modules/settings.service';
import { TenantsService } from '../modules/tenants.service';
import { InboxService } from '../modules/inbox.service';
import { TemplatesService } from '../modules/templates.service';
import { HealthService } from '../modules/health.service';
import { CampaignsService } from '../modules/campaigns';
import { SavedRepliesService, TagsService } from '../modules/inbox-tools';
import { ContactImportService, listContacts } from '../modules/contacts-import';
import { AssignmentService } from '../modules/auto-assign';
import { ReportsService } from '../modules/reports';
import { AutomationsService } from '../modules/automations';
import { AiService } from '../modules/ai';
import { timingSafeEqual } from 'node:crypto';
import { verifySignature } from '../modules/channels';
import type { Deps } from '../core/context';
import { DEPS } from './tokens';
import { AppError } from '../core/errors';
import {
  ApiKeyAuth, AllowPendingMfa, CurrentActor, CurrentSession, Public, RequirePermission, SESSION_COOKIE, SignedWebhook, type CfRequest,
} from './guard';

const client = (req: CfRequest): ClientInfo => ({ ip: req.ip ?? 'unknown', userAgent: req.headers['user-agent'] });

@Controller()
export class HealthController {
  @Public() @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public() @Post('signup') @HttpCode(202)
  async signup(@Body() body: unknown, @Req() req: CfRequest) {
    await this.auth.signup(body, client(req));
    return { message: 'If this email can be used, we have sent a verification link.' };
  }

  @Public() @Post('verify-email') @HttpCode(204)
  async verifyEmail(@Body() body: unknown) {
    await this.auth.verifyEmail(parse(VerifyEmailRequest, body).token);
  }

  @Public() @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: CfRequest, @Res({ passthrough: true }) res: Response) {
    const { token, mfaRequired } = await this.auth.login(body, client(req));
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 3600 * 1000,
      secure: process.env.NODE_ENV === 'production',
    });
    return { mfaRequired };
  }

  @AllowPendingMfa() @Post('mfa/challenge') @HttpCode(204)
  async mfaChallenge(@Body() body: unknown, @CurrentSession() session: AuthSession) {
    await this.auth.completeMfa(session, parse(MfaChallengeRequest, body));
  }

  @Post('mfa/totp/setup')
  totpSetup(@CurrentSession() session: AuthSession) {
    return this.auth.beginTotpSetup(session);
  }

  @Post('mfa/totp/confirm') @HttpCode(202)
  totpConfirm(@Body() body: unknown, @CurrentSession() session: AuthSession) {
    return this.auth.confirmTotp(session, parse(MfaConfirmRequest, body).code);
  }

  /** The code from the confirmation email (M7), entered in the session that started set-up. */
  @Post('mfa/totp/activate') @HttpCode(201)
  totpActivate(@Body() body: unknown, @CurrentSession() session: AuthSession) {
    return this.auth.activateTotp(session, parse(MfaActivateRequest, body).code);
  }

  @AllowPendingMfa() @Post('logout') @HttpCode(204)
  async logout(@CurrentSession() session: AuthSession, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(session);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Public() @Post('password/forgot') @HttpCode(202)
  async forgot(@Body() body: unknown) {
    await this.auth.forgotPassword(body);
    return { message: 'If an account exists for this email, we have sent a reset link.' };
  }

  @Public() @Post('password/reset') @HttpCode(204)
  async reset(@Body() body: unknown) {
    await this.auth.resetPassword(body);
  }

  @Get('sessions')
  sessions(@CurrentSession() session: AuthSession) {
    return this.auth.listSessions(session);
  }

  @Delete('sessions/:id') @HttpCode(204)
  async revoke(@CurrentSession() session: AuthSession, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Errors.notFound('Session');
    await this.auth.revokeSession(session, id);
  }
}

@Controller('v1/me')
export class MeController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(DEPS) private readonly deps: Deps, @Inject(AiService) private readonly ai: AiService) {}

  /**
   * What this installation can actually verify, so screens never present simulated or test results as real ones:
   * whether WhatsApp is the sandbox simulation, what malware scans are based on, and the file size limit.
   */
  @RequirePermission('tenant.read') @Get('environment')
  async environment(@CurrentActor() actor: TenantActor) {
    const scan = this.deps.scanner.basis ? await this.deps.scanner.basis().catch(() => null) : null;
    return {
      ai: await this.ai.status(actor),
      whatsapp: { sandbox: !!this.deps.channels.sandbox, live: !!this.deps.channels.whatsapp_cloud },
      scanner: { basis: scan?.basis ?? 'unverified_signatures', signatureVersion: scan?.signatureVersion ?? null },
      maxFileBytes: this.deps.config.MAX_UPLOAD_BYTES,
    };
  }

  @Get()
  me(@CurrentSession() session: AuthSession) {
    return this.auth.me(session);
  }

  @Get('tenants')
  myTenants(@CurrentSession() session: AuthSession) {
    return this.tenants.listMine(session);
  }

  @Post('active-tenant') @HttpCode(204)
  async switchTenant(@CurrentSession() session: AuthSession, @Body() body: unknown) {
    await this.tenants.switchTo(session, body);
  }
  /** What I can do in the active company, so screens show only actions the server will allow. */
  @RequirePermission('tenant.read') @Get('access')
  access(@CurrentActor() actor: TenantActor) {
    return { membershipId: actor.membershipId, roles: actor.roles, permissions: [...actor.permissions].sort() };
  }
}

@Controller('v1')
export class TenantsController {
  constructor(@Inject(TenantsService) private readonly tenants: TenantsService) {}

  @Post('tenants')
  create(@CurrentSession() session: AuthSession, @Body() body: unknown) {
    return this.tenants.create(session, body);
  }

  @RequirePermission('tenant.read') @Get('tenant')
  get(@CurrentActor() actor: TenantActor) {
    return this.tenants.get(actor);
  }

  @RequirePermission('tenant.update') @Patch('tenant')
  update(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.tenants.update(actor, body);
  }
}

@Controller('v1')
export class MembersController {
  constructor(@Inject(MembersService) private readonly members: MembersService) {}

  @RequirePermission('members.read') @Get('members')
  list(@CurrentActor() actor: TenantActor) {
    return this.members.list(actor);
  }

  @RequirePermission('members.read') @Get('members/:id')
  get(@CurrentActor() actor: TenantActor, @Param('id') id: string) {
    return this.members.get(actor, id);
  }

  @RequirePermission('members.invite') @Post('invitations') @HttpCode(201)
  invite(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.members.invite(actor, body);
  }

  @RequirePermission('members.invite') @Get('invitations')
  invitations(@CurrentActor() actor: TenantActor) {
    return this.members.listInvitations(actor);
  }

  @RequirePermission('members.invite') @Delete('invitations/:id') @HttpCode(204)
  async revokeInvitation(@CurrentActor() actor: TenantActor, @Param('id') id: string) {
    await this.members.revokeInvitation(actor, id);
  }

  @Post('invitations/accept')
  accept(@CurrentSession() session: AuthSession, @Body() body: unknown) {
    return this.members.accept(session, body);
  }

  @RequirePermission('members.manage') @Put('members/:id/roles') @HttpCode(204)
  async setRoles(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    await this.members.setRoles(actor, id, body);
  }

  @RequirePermission('members.manage') @Delete('members/:id') @HttpCode(204)
  async remove(@CurrentActor() actor: TenantActor, @Param('id') id: string) {
    await this.members.remove(actor, id);
  }

  @RequirePermission('roles.read') @Get('roles')
  roles(@CurrentActor() actor: TenantActor) {
    return this.members.listRoles(actor);
  }

  @RequirePermission('roles.manage') @Post('roles') @HttpCode(201)
  createRole(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.members.createRole(actor, body);
  }
}

@Controller('v1')
export class BillingController {
  constructor(@Inject(EntitlementsService) private readonly entitlements: EntitlementsService) {}

  @RequirePermission('billing.read') @Get('entitlements')
  summary(@CurrentActor() actor: TenantActor) {
    return this.entitlements.summary(actor);
  }
}

@Controller('v1/audit-events')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @RequirePermission('audit.read') @Get()
  list(@CurrentActor() actor: TenantActor, @Query('before') before?: string, @Query('limit') limit?: string) {
    const n = limit === undefined ? 50 : Number(limit);
    const b = before === undefined ? undefined : Number(before);
    if (!Number.isInteger(n) || (b !== undefined && !Number.isInteger(b))) throw Errors.badRequest('limit and before must be whole numbers.');
    return this.audit.list(actor, n, b);
  }

  @RequirePermission('audit.read') @Get('verify')
  verify(@CurrentActor() actor: TenantActor) {
    return this.audit.verify(actor);
  }
}

@Controller('v1/files')
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @RequirePermission('files.write') @Post() @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 16 * 1024 * 1024), files: 1 } }))
  upload(@CurrentActor() actor: TenantActor, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw Errors.badRequest('Attach a file in the "file" field.');
    return this.files.upload(actor, { originalName: file.originalname, contentType: file.mimetype, data: file.buffer });
  }

  @RequirePermission('files.read') @Get()
  list(@CurrentActor() actor: TenantActor) {
    return this.files.list(actor);
  }

  // Declared before ':id'. Needs a signed-in session; the link itself carries the company and user.
  @Get('download')
  async download(@CurrentSession() session: AuthSession, @Query('token') token: string, @Res() res: Response) {
    const file = await this.files.download(session, token);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.data);
  }

  @RequirePermission('files.read') @Get(':id')
  get(@CurrentActor() actor: TenantActor, @Param('id') id: string) {
    return this.files.get(actor, id);
  }

  @RequirePermission('files.read') @Post(':id/link')
  link(@CurrentActor() actor: TenantActor, @Param('id') id: string) {
    return this.files.createLink(actor, id);
  }
}

@Controller('v1')
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @RequirePermission('tenant.read') @Get('settings')
  get(@CurrentActor() actor: TenantActor) {
    return this.settings.getSettings(actor);
  }

  @RequirePermission('tenant.update') @Patch('settings')
  update(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.settings.updateSettings(actor, body);
  }

  @RequirePermission('tenant.update') @Post('settings/holidays') @HttpCode(201)
  addHoliday(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.settings.addHoliday(actor, body);
  }

  @RequirePermission('tenant.update') @Delete('settings/holidays/:id') @HttpCode(204)
  async removeHoliday(@CurrentActor() actor: TenantActor, @Param('id') id: string) {
    await this.settings.removeHoliday(actor, id);
  }

  @RequirePermission('members.read') @Get('branches')
  branches(@CurrentActor() actor: TenantActor) {
    return this.settings.listBranches(actor);
  }

  @RequirePermission('tenant.update') @Post('branches') @HttpCode(201)
  createBranch(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.settings.createBranch(actor, body);
  }

  @RequirePermission('members.read') @Get('teams')
  teams(@CurrentActor() actor: TenantActor) {
    return this.settings.listTeams(actor);
  }

  @RequirePermission('members.manage') @Post('teams') @HttpCode(201)
  createTeam(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.settings.createTeam(actor, body);
  }

  @RequirePermission('members.manage') @Post('teams/:id/members') @HttpCode(204)
  async addTeamMember(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    await this.settings.addTeamMember(actor, id, body);
  }

  @RequirePermission('tenant.read') @Get('features')
  features(@CurrentActor() actor: TenantActor) {
    return this.settings.features(actor);
  }

  @RequirePermission('tenant.read') @Get('support-grants')
  supportGrants(@CurrentActor() actor: TenantActor) {
    return this.settings.supportGrants(actor);
  }
}

/** Platform owner console. Staff only, with two-step verification; checked on every call. */
@Controller('v1/platform')
export class PlatformController {
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  @Get('tenants')
  async directory(@CurrentSession() s: AuthSession) {
    return this.platform.directory(await this.platform.requireStaff(s));
  }

  @Get('plans')
  async plans(@CurrentSession() s: AuthSession) {
    return this.platform.plans(await this.platform.requireStaff(s));
  }

  @Post('plans/versions/:id/publish') @HttpCode(204)
  async publish(@CurrentSession() s: AuthSession, @Param('id') id: string) {
    await this.platform.publishPlanVersion(await this.platform.requireStaff(s, 'platform_owner'), id);
  }

  @Put('tenants/:id/features/:key') @HttpCode(204)
  async setFlag(@CurrentSession() s: AuthSession, @Param('id') id: string, @Param('key') key: string, @Body() body: unknown) {
    await this.platform.setFeatureFlag(await this.platform.requireStaff(s, 'platform_owner'), id, key, body);
  }

  @Get('mfa-resets')
  async listMfaResets(@CurrentSession() s: AuthSession) {
    return this.platform.listMfaResets(await this.platform.requireStaff(s, 'platform_owner'));
  }

  @Post('mfa-resets') @HttpCode(201)
  async requestMfaReset(@CurrentSession() s: AuthSession, @Body() body: unknown) {
    return this.platform.requestMfaReset(await this.platform.requireStaff(s, 'platform_owner'), body);
  }

  @Post('mfa-resets/:id/approve') @HttpCode(200)
  async approveMfaReset(@CurrentSession() s: AuthSession, @Param('id') id: string) {
    return this.platform.approveMfaReset(await this.platform.requireStaff(s, 'platform_owner'), id);
  }

  @Post('mfa-resets/:id/reject') @HttpCode(204)
  async rejectMfaReset(@CurrentSession() s: AuthSession, @Param('id') id: string) {
    await this.platform.rejectMfaReset(await this.platform.requireStaff(s, 'platform_owner'), id);
  }

  @Post('tenants/:id/pilot') @HttpCode(201)
  async enrolPilot(@CurrentSession() s: AuthSession, @Param('id') id: string, @Body() body: unknown) {
    return this.platform.enrolPilot(await this.platform.requireStaff(s, 'platform_owner'), id, body);
  }

  @Post('tenants/:id/pilot/end') @HttpCode(204)
  async endPilot(@CurrentSession() s: AuthSession, @Param('id') id: string) {
    await this.platform.endPilot(await this.platform.requireStaff(s, 'platform_owner'), id);
  }

  @Post('support-grants') @HttpCode(201)
  async request(@CurrentSession() s: AuthSession, @Body() body: unknown) {
    return this.platform.requestSupport(await this.platform.requireStaff(s), body);
  }

  @Post('support-grants/:id/approve')
  async approve(@CurrentSession() s: AuthSession, @Param('id') id: string) {
    return this.platform.approveSupport(await this.platform.requireStaff(s, 'platform_owner'), id);
  }

  @Post('support-grants/:id/revoke') @HttpCode(204)
  async revoke(@CurrentSession() s: AuthSession, @Param('id') id: string) {
    await this.platform.revokeSupport(await this.platform.requireStaff(s), id);
  }

  @Get('tenants/:id/files')
  async supportFiles(@CurrentSession() s: AuthSession, @Param('id') id: string) {
    return this.platform.supportView(await this.platform.requireStaff(s), id, 'files');
  }

  @Get('tenants/:id/members')
  async supportMembers(@CurrentSession() s: AuthSession, @Param('id') id: string) {
    return this.platform.supportView(await this.platform.requireStaff(s), id, 'members');
  }

  // Messaging route per company, partner numbers, consent wording and partner funding (migration 0064).
  @Put('tenants/:id/messaging-route')
  async setRoute(@CurrentSession() s: AuthSession, @Param('id') id: string, @Body() body: unknown) {
    return this.platform.setRoute(await this.platform.requireStaff(s, 'platform_owner'), id, body);
  }
  @Post('tenants/:id/partner-channels') @HttpCode(201)
  async partnerChannel(@CurrentSession() s: AuthSession, @Param('id') id: string, @Body() body: unknown) {
    return this.platform.connectPartnerChannel(await this.platform.requireStaff(s, 'platform_owner'), id, body);
  }
  @Get('credits/consent-wording')
  async consentList(@CurrentSession() s: AuthSession) {
    return this.platform.consentList(await this.platform.requireStaff(s, 'platform_owner'));
  }
  @Post('credits/consent-wording') @HttpCode(201)
  async consentAdd(@CurrentSession() s: AuthSession, @Body() body: unknown) {
    return this.platform.consentAdd(await this.platform.requireStaff(s, 'platform_owner'), body);
  }
  @Put('credits/consent-wording/:version/:locale')
  async consentSet(@CurrentSession() s: AuthSession, @Param('version') version: string, @Param('locale') locale: string, @Body() body: unknown) {
    return this.platform.consentSet(await this.platform.requireStaff(s, 'platform_owner'), version, locale, body);
  }
  /** Signed payment events that could not be applied (money may have been taken without credit): for a person to check. */
  @Get('credits/unmatched-events')
  async creditUnmatched(@CurrentSession() s: AuthSession) {
    return this.platform.creditUnmatched(await this.platform.requireStaff(s, 'platform_owner'));
  }
  @Put('credits/unmatched-events/:id')
  async creditUnmatchedResolve(@CurrentSession() s: AuthSession, @Param('id') id: string, @Body() body: unknown) {
    return this.platform.creditUnmatchedResolve(await this.platform.requireStaff(s, 'platform_owner'), id, body);
  }
  @Get('partner/funding')
  async partnerOverview(@CurrentSession() s: AuthSession) {
    return this.platform.partnerOverview(await this.platform.requireStaff(s, 'platform_owner'));
  }
  @Post('partner/funding') @HttpCode(201)
  async partnerRecord(@CurrentSession() s: AuthSession, @Body() body: unknown) {
    return this.platform.partnerRecord(await this.platform.requireStaff(s, 'platform_owner'), body);
  }
  @Put('partner/funding/settings')
  async partnerSettings(@CurrentSession() s: AuthSession, @Body() body: unknown) {
    return this.platform.partnerSettings(await this.platform.requireStaff(s, 'platform_owner'), body);
  }

  // Prepaid message credits (migration 0061): platform owners only, each action bound to the session in the database.
  @Post('tenants/:id/credits/account') @HttpCode(201)
  async creditOpen(@CurrentSession() s: AuthSession, @Param('id') id: string, @Body() body: unknown) {
    return this.platform.creditOpenAccount(await this.platform.requireStaff(s, 'platform_owner'), id, body);
  }
  @Post('credits/rate-cards') @HttpCode(201)
  async creditRates(@CurrentSession() s: AuthSession, @Body() body: unknown) {
    return this.platform.creditPublishRates(await this.platform.requireStaff(s, 'platform_owner'), body);
  }
  @Put('credits/margin')
  async creditMargin(@CurrentSession() s: AuthSession, @Body() body: unknown) {
    return this.platform.creditSetMargin(await this.platform.requireStaff(s, 'platform_owner'), body);
  }
  @Post('tenants/:id/credits/adjustments') @HttpCode(201)
  async creditAdjust(@CurrentSession() s: AuthSession, @Param('id') id: string, @Body() body: unknown) {
    return this.platform.creditAdjust(await this.platform.requireStaff(s, 'platform_owner'), id, body);
  }
  @Put('tenants/:id/credits/partner-cost')
  async creditPartnerCost(@CurrentSession() s: AuthSession, @Param('id') id: string, @Body() body: unknown) {
    return this.platform.creditPartnerCost(await this.platform.requireStaff(s, 'platform_owner'), id, body);
  }
  @Get('credits/reconciliation/:month')
  async creditReconciliation(@CurrentSession() s: AuthSession, @Param('month') month: string) {
    return this.platform.creditReconciliation(await this.platform.requireStaff(s, 'platform_owner'), month);
  }
}

/** Prepaid WhatsApp message credits for this company (migration 0061). Separate from the subscription. */
@Controller('v1/credits')
export class CreditsController {
  constructor(@Inject(CreditsService) private readonly credits: CreditsService) {}

  @RequirePermission('billing.read') @Get()
  account(@CurrentActor() actor: TenantActor) { return this.credits.account(actor); }
  @RequirePermission('billing.read') @Get('entries')
  entries(@CurrentActor() actor: TenantActor, @Query() q: { before?: string; limit?: string }) { return this.credits.entries(actor, q); }
  @RequirePermission('billing.read') @Get('topups')
  topups(@CurrentActor() actor: TenantActor) { return this.credits.topups(actor); }
  @RequirePermission('billing.read') @Get('documents/:id')
  document(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.credits.document(actor, id); }
  @RequirePermission('billing.read') @Get('statements/:month')
  statement(@CurrentActor() actor: TenantActor, @Param('month') month: string) { return this.credits.statement(actor, month); }
  @RequirePermission('billing.read') @Post('notices/read') @HttpCode(200)
  noticesRead(@CurrentActor() actor: TenantActor) { return this.credits.markNoticesRead(actor); }

  @RequirePermission('billing.manage') @Post('topups') @HttpCode(201)
  topUp(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.credits.startTopUp(actor, body); }
  @RequirePermission('billing.manage') @Put('settings')
  settings(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.credits.saveSettings(actor, body); }
  @RequirePermission('billing.manage') @Put('auto-topup')
  auto(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.credits.setAuto(actor, body); }
  @RequirePermission('billing.manage') @Post('refunds') @HttpCode(201)
  refund(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.credits.refund(actor, body); }

  // Test mode only (refused in production and with any real provider).
  @RequirePermission('billing.manage') @Post('test/topups/:id/complete') @HttpCode(200)
  simulate(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: { outcome?: string }) {
    return this.credits.simulateCheckout(actor, id, body?.outcome === 'failed' ? 'failed' : 'succeeded');
  }
  @RequirePermission('billing.manage') @Post('test/methods') @HttpCode(201)
  testMethod(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.credits.addTestMethod(actor, body); }
  @RequirePermission('billing.manage') @Delete('methods/:id')
  removeMethod(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.credits.removeMethod(actor, id); }
}

/**
 * 360dialog webhooks (partner route). Same format as Meta's; authenticated by the secret header set when the webhook
 * is registered with 360dialog. Only active when the partner route is configured.
 */
@Controller('v1/webhooks/dialog360')
export class Dialog360WebhookController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService, @Inject(DEPS) private readonly deps: Deps) {}
  @SignedWebhook() @Post() @HttpCode(200)
  async receive(@Req() req: CfRequest, @Body() body: unknown) {
    if (!this.deps.channels.dialog360) throw Errors.notFound('Webhook');
    const token = req.headers['x-cf-partner-token'];
    if (!webhookTokenOk(this.deps.config.DIALOG360_WEBHOOK_TOKEN, typeof token === 'string' ? token : undefined)) {
      throw new AppError(401, 'invalid_signature', 'Webhook token check failed.');
    }
    return this.inbox.ingest('dialog360', body);
  }
}

/** Payment provider events for credit top-ups: the signature over the exact bytes is checked before anything else. */
@Controller('v1/webhooks/credits')
export class CreditPaymentWebhookController {
  constructor(@Inject(CreditsService) private readonly credits: CreditsService) {}
  @SignedWebhook() @Post(':provider') @HttpCode(200)
  async receive(@Param('provider') provider: string, @Req() req: CfRequest & { rawBody?: Buffer }) {
    const sig = req.headers[this.credits.signatureHeaderFor(provider)];
    const outcome = await this.credits.handleEvent(provider, req.rawBody?.toString('utf8') ?? '', typeof sig === 'string' ? sig : undefined);
    return { outcome };
  }
}

@Controller('v1/ai')
export class AiController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  @RequirePermission('ai.manage') @Get('settings')
  settings(@CurrentActor() actor: TenantActor) { return this.ai.settings(actor); }

  @RequirePermission('ai.manage') @Put('settings')
  save(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.ai.saveSettings(actor, body); }
}

@Controller('v1/knowledge')
export class KnowledgeController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  @RequirePermission('knowledge.manage') @Get()
  list(@CurrentActor() actor: TenantActor) { return this.ai.listArticles(actor); }

  @RequirePermission('knowledge.manage') @Post() @HttpCode(201)
  create(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.ai.saveArticle(actor, null, body); }

  @RequirePermission('knowledge.manage') @Put(':id')
  update(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.ai.saveArticle(actor, id, body); }

  @RequirePermission('knowledge.manage') @Delete(':id')
  remove(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.ai.deleteArticle(actor, id); }
}

@Controller('v1/automations')
export class AutomationsController {
  constructor(@Inject(AutomationsService) private readonly svc: AutomationsService) {}

  @RequirePermission('automations.manage') @Get()
  list(@CurrentActor() actor: TenantActor) { return this.svc.list(actor); }

  @RequirePermission('automations.manage') @Post() @HttpCode(201)
  create(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.svc.create(actor, body); }

  @RequirePermission('automations.manage') @Get(':id')
  get(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.svc.get(actor, id); }

  @RequirePermission('automations.manage') @Put(':id/draft')
  saveDraft(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.svc.saveDraft(actor, id, body); }

  @RequirePermission('automations.manage') @Post(':id/publish') @HttpCode(200)
  publish(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.svc.publish(actor, id, body); }

  @RequirePermission('automations.manage') @Post(':id/rollback') @HttpCode(200)
  rollback(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.svc.rollback(actor, id, body); }

  @RequirePermission('automations.manage') @Post(':id/pause') @HttpCode(200)
  pause(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.svc.setStatus(actor, id, 'paused', body); }

  @RequirePermission('automations.manage') @Post(':id/resume') @HttpCode(200)
  resume(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.svc.setStatus(actor, id, 'active', body); }

  @RequirePermission('automations.manage') @Post(':id/archive') @HttpCode(200)
  archive(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.svc.setStatus(actor, id, 'archived', body); }

  /** Rehearsal: runs the draft (or published version) against a sample message. Nothing is sent or changed. */
  @RequirePermission('automations.manage') @Post(':id/rehearse') @HttpCode(201)
  rehearse(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.svc.rehearse(actor, id, body); }
}

@Controller('v1/automation-runs')
export class AutomationRunsController {
  constructor(@Inject(AutomationsService) private readonly svc: AutomationsService) {}

  @RequirePermission('automations.manage') @Get(':id')
  get(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.svc.run(actor, id); }
}

@Controller('v1/reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService, @Inject(OutcomesService) private readonly outcomes: OutcomesService) {}

  /** Outcomes and known costs for a period (W2.9), with what is not measured yet and the assumptions used. */
  @RequirePermission('reports.read') @Get('outcomes')
  outcomesReport(@CurrentActor() actor: TenantActor, @Query() q: Record<string, string>) {
    return this.outcomes.report(actor, q);
  }

  /** Click-to-WhatsApp ads: conversations credited to each ad and what happened next (counts only). */
  @RequirePermission('reports.read') @Get('ads')
  ads(@CurrentActor() actor: TenantActor, @Query() q: Record<string, string>) {
    return this.reports.ads(actor, q);
  }
}

@Controller('v1/channels')
export class ChannelsController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService, @Inject(HealthService) private readonly health: HealthService) {}

  @RequirePermission('channels.monitor') @Get('health')
  overview(@CurrentActor() actor: TenantActor) {
    return this.health.overview(actor);
  }

  /** Recovery: re-applies delivery statuses that arrived before their message (safe to repeat). */
  @RequirePermission('channels.manage') @Post('recovery/statuses') @HttpCode(200)
  reapplyStatuses(@CurrentActor() actor: TenantActor) {
    return this.health.reapplyStatuses(actor);
  }

  /** Recovery: tries again incoming events the worker gave up on (AX-3). Applying never sends anything. */
  @RequirePermission('channels.manage') @Post('recovery/incoming') @HttpCode(200)
  retryIncoming(@CurrentActor() actor: TenantActor) {
    return this.health.retryIncoming(actor);
  }

  /** Recovery: downloads a customer's media again after a failed download. Never sends anything. */
  @RequirePermission('channels.manage') @Post('recovery/media/:messageId') @HttpCode(200)
  retryMedia(@CurrentActor() actor: TenantActor, @Param('messageId') id: string) {
    return this.health.retryMedia(actor, id);
  }

  @RequirePermission('tenant.read') @Get()
  list(@CurrentActor() actor: TenantActor) {
    return this.inbox.listChannels(actor);
  }

  @RequirePermission('channels.manage') @Post() @HttpCode(201)
  connect(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.inbox.connectChannel(actor, body);
  }
}

/**
 * Sandbox webhook, shaped like Meta's: GET answers the subscription check, POST carries signed events.
 * The live Cloud API endpoint will follow the same pattern with Meta's app secret.
 */
@Controller('v1/webhooks/sandbox')
export class WebhooksController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService, @Inject(DEPS) private readonly deps: Deps) {}

  @SignedWebhook() @Get()
  verify(@Query() q: Record<string, string>, @Res() res: Response) {
    if (!this.deps.channels.sandbox) throw Errors.notFound('Webhook');
    const given = Buffer.from(String(q['hub.verify_token'] ?? ''));
    const expected = Buffer.from(this.deps.keys.sandboxVerifyToken);
    const tokenOk = given.length === expected.length && timingSafeEqual(given, expected);
    if (q['hub.mode'] !== 'subscribe' || !tokenOk || !q['hub.challenge']) {
      throw new AppError(403, 'forbidden', 'Verification failed.');
    }
    res.status(200).type('text/plain').send(String(q['hub.challenge']).slice(0, 200));
  }

  @SignedWebhook() @Post() @HttpCode(200)
  async receive(@Req() req: CfRequest & { rawBody?: Buffer }, @Body() body: unknown) {
    if (!this.deps.channels.sandbox) throw Errors.notFound('Webhook');
    const sig = req.headers['x-hub-signature-256'];
    if (!verifySignature(this.deps.keys.sandboxWebhook, req.rawBody, typeof sig === 'string' ? sig : undefined)) {
      throw new AppError(401, 'invalid_signature', 'Signature check failed.');
    }
    return this.inbox.ingest('sandbox', body);
  }
}

/** Conversa Operator, slice 1: settings, price lists, cases and quotes (Operator addendum v1.0). */
@Controller('v1/operator')
export class OperatorController {
  constructor(@Inject(OperatorService) private readonly op: OperatorService) {}

  @RequirePermission('operator.quote') @Get('settings')
  settings(@CurrentActor() actor: TenantActor) { return this.op.settings(actor); }
  @RequirePermission('operator.manage') @Put('settings')
  saveSettings(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.op.saveSettings(actor, body); }
  @RequirePermission('operator.manage') @Post('pause') @HttpCode(200)
  pause(@CurrentActor() actor: TenantActor, @Body() body: { reason?: string }) { return this.op.setPause(actor, true, typeof body?.reason === 'string' ? body.reason : undefined); }
  @RequirePermission('operator.manage') @Post('resume') @HttpCode(200)
  resume(@CurrentActor() actor: TenantActor) { return this.op.setPause(actor, false); }

  @RequirePermission('operator.quote') @Get('rate-cards')
  rateCards(@CurrentActor() actor: TenantActor) { return this.op.rateCards(actor); }
  @RequirePermission('operator.manage') @Post('rate-cards') @HttpCode(201)
  createRateCard(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.op.createRateCard(actor, body); }
  @RequirePermission('operator.manage') @Post('rate-cards/:id/publish') @HttpCode(200)
  publish(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.op.publishRateCard(actor, id); }

  @RequirePermission('operator.quote') @Get('conversations/:id/cases')
  cases(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.op.casesForConversation(actor, id); }
  @RequirePermission('operator.quote') @Post('conversations/:id/cases') @HttpCode(201)
  openCase(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.op.openCase(actor, id); }
  @RequirePermission('operator.quote') @Get('cases/:id')
  getCase(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.op.getCase(actor, id); }
  @RequirePermission('operator.quote') @Patch('cases/:id/facts')
  facts(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.op.updateFacts(actor, id, body); }
  @RequirePermission('operator.quote') @Post('cases/:id/quotes') @HttpCode(201)
  quote(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.op.createQuote(actor, id, body); }

  @RequirePermission('operator.approve') @Get('approvals')
  approvals(@CurrentActor() actor: TenantActor) { return this.op.approvals(actor); }
  @RequirePermission('operator.approve') @Post('quotes/:id/approve') @HttpCode(200)
  approve(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.op.approve(actor, id, body); }
  @RequirePermission('operator.quote') @Post('quotes/:id/send') @HttpCode(200)
  send(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.op.send(actor, id, body); }
  @RequirePermission('operator.quote') @Post('quotes/:id/withdraw') @HttpCode(200)
  withdraw(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.op.withdraw(actor, id, body); }
  // Recording an acceptance given another way stands in for the customer: approval permission with two-step sign-in (review M2).
  @RequirePermission('operator.approve') @Post('quotes/:id/record-acceptance') @HttpCode(200)
  recordAcceptance(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.op.recordAcceptance(actor, id, body); }
}

/**
 * The customer's quote page (Operator slice 1). No sign-in: the single-use link, sent in the X-Quote-Link header, is
 * looked up again on every request. Opening shows the quote; only an explicit acceptance with the version accepts it.
 */
@Controller('v1/quote')
export class QuotePortalController {
  constructor(@Inject(QuotePortalService) private readonly portal: QuotePortalService) {}
  private link(req: CfRequest) {
    const h = req.headers[QUOTE_LINK_HEADER];
    return this.portal.open(typeof h === 'string' ? h : undefined, req.ip ?? null);
  }
  @Public() @Get()
  async view(@Req() req: CfRequest) { return this.portal.view(await this.link(req)); }
  @Public() @Post('accept') @HttpCode(200)
  async accept(@Req() req: CfRequest, @Body() body: unknown) { return this.portal.accept(await this.link(req), body); }
}

/**
 * Customer control centre (W2.4). No sign-in: the customer's link, sent in the X-Customer-Link header, is looked up
 * again on every request. State changes still need the usual X-Requested-With header (the page sends it).
 */
@Controller('v1/customer')
export class CustomerPortalController {
  constructor(@Inject(CustomerPortalService) private readonly portal: CustomerPortalService) {}
  private link(req: CfRequest) {
    const h = req.headers[LINK_HEADER];
    return this.portal.open(typeof h === 'string' ? h : undefined, req.ip ?? null);
  }

  @Public() @Get('portal')
  async view(@Req() req: CfRequest) { return this.portal.view(await this.link(req)); }

  @Public() @Post('preferences') @HttpCode(200)
  async prefs(@Req() req: CfRequest, @Body() body: unknown) { return this.portal.setPreferences(await this.link(req), body); }

  @Public() @Post('consent') @HttpCode(200)
  async consent(@Req() req: CfRequest, @Body() body: unknown) { return this.portal.setConsent(await this.link(req), body); }

  @Public() @Post('requests') @HttpCode(201)
  async request(@Req() req: CfRequest, @Body() body: unknown) { return this.portal.request(await this.link(req), body); }
}

@Controller('v1')
export class CustomerLinksController {
  constructor(@Inject(CustomerLinksService) private readonly links: CustomerLinksService) {}

  @RequirePermission('inbox.reply') @Post('conversations/:id/customer-links')
  issue(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.links.issue(actor, id, body); }

  @RequirePermission('inbox.reply') @Get('conversations/:id/customer-links')
  list(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.links.list(actor, id); }

  @RequirePermission('inbox.reply') @Post('conversations/:id/customer-links/revoke-all') @HttpCode(200)
  revokeAll(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.links.revokeAll(actor, id); }

  @RequirePermission('inbox.reply') @Post('customer-links/:id/revoke') @HttpCode(200)
  revoke(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.links.revoke(actor, id); }

  @RequirePermission('inbox.reply') @Get('conversations/:id/customer-requests')
  requests(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.links.requests(actor, id); }

  @RequirePermission('inbox.reply') @Post('customer-requests/:id/handled') @HttpCode(200)
  handle(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.links.handle(actor, id); }
}

/** Notifications on this member's devices (W2.5). Every member manages their own; nothing about anyone else. */
@Controller('v1/me/notifications')
export class NotificationsController {
  constructor(@Inject(PushService) private readonly push: PushService) {}

  @RequirePermission('inbox.reply') @Get('info')
  info() { return this.push.info(); }

  @RequirePermission('inbox.reply') @Get('preferences')
  prefs(@CurrentActor() actor: TenantActor) { return this.push.preferences(actor); }

  @RequirePermission('inbox.reply') @Put('preferences')
  setPrefs(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.push.setPreferences(actor, body); }

  @RequirePermission('inbox.reply') @Get('devices')
  devices(@CurrentActor() actor: TenantActor) { return this.push.devices(actor); }

  @RequirePermission('inbox.reply') @Post('devices') @HttpCode(201)
  add(@CurrentActor() actor: TenantActor, @Body() body: unknown, @Req() req: CfRequest) { return this.push.subscribe(actor, body, req.headers['user-agent']); }

  @RequirePermission('inbox.reply') @Post('devices/remove') @HttpCode(200)
  removeHere(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.push.unsubscribeEndpoint(actor, body); }

  @RequirePermission('inbox.reply') @Delete('devices/:id')
  remove(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.push.unsubscribe(actor, id); }

  @RequirePermission('inbox.reply') @Post('test') @HttpCode(201)
  test(@CurrentActor() actor: TenantActor) { return this.push.test(actor); }
}

/** Promises made to customers (W2.6). Visibility follows the inbox rule. */
@Controller('v1')
export class PromisesController {
  constructor(@Inject(PromisesService) private readonly promises: PromisesService) {}

  @RequirePermission('inbox.reply') @Get('promises')
  list(@CurrentActor() actor: TenantActor, @Query() q: unknown) { return this.promises.list(actor, q); }

  @RequirePermission('inbox.reply') @Get('conversations/:id/promises')
  forConversation(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.promises.forConversation(actor, id); }

  @RequirePermission('inbox.reply') @Post('conversations/:id/promises') @HttpCode(201)
  create(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.promises.create(actor, id, body); }

  @RequirePermission('inbox.reply') @Post('promises/:id/confirm') @HttpCode(200)
  confirm(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.promises.confirm(actor, id, body); }

  @RequirePermission('inbox.reply') @Post('promises/:id/close') @HttpCode(200)
  close(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.promises.close(actor, id, body); }

  @RequirePermission('inbox.assign') @Get('promises/settings')
  settings(@CurrentActor() actor: TenantActor) { return this.promises.settings(actor); }

  // Automatic confirmation is a company decision: company settings permission (review of W2.6).
  @RequirePermission('tenant.update') @Put('promises/settings')
  saveSettings(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.promises.saveSettings(actor, body); }
}

/**
 * Public API v1 (W2.8), for a company's own systems. Authenticated by API key; every request is logged.
 * Base path /api/v1 on the API host (not the web app's address).
 */
@Controller('api/v1')
export class PublicApiController {
  constructor(@Inject(ApiAuth) private readonly auth: ApiAuth, @Inject(PublicApiReads) private readonly reads: PublicApiReads,
    @Inject(InboxService) private readonly inbox: InboxService, @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(DEPS) private readonly deps: Deps) {}

  private async run<T>(req: CfRequest, route: string, fn: (c: ApiCaller) => Promise<T>): Promise<T> {
    const started = Date.now();
    let caller: ApiCaller | null = null;
    try {
      caller = await this.auth.resolve(req.headers.authorization, req.ip ?? null);
      const out = await fn(caller);
      await this.auth.logRequest(caller, req.method, route, req.method === 'POST' ? 201 : 200, started);
      return out;
    } catch (err) {
      await this.auth.logRequest(caller, req.method, route, err instanceof AppError ? err.status : 500, started);
      throw err;
    }
  }

  @ApiKeyAuth() @Get('conversations')
  conversations(@Req() req: CfRequest, @Query() q: unknown) {
    return this.run(req, 'GET /conversations', async (c) => { requireScope(c, 'conversations:read'); return this.reads.conversations(c, q); });
  }

  @ApiKeyAuth() @Get('conversations/:id/messages')
  messages(@Req() req: CfRequest, @Param('id') id: string, @Query() q: unknown) {
    return this.run(req, 'GET /conversations/:id/messages', async (c) => { requireScope(c, 'conversations:read'); return this.reads.messages(c, id, q); });
  }

  /** Sends a reply as the key's member, with every check a person's reply gets. Idempotency-Key (a UUID) is required. */
  @ApiKeyAuth() @Post('conversations/:id/messages') @HttpCode(201)
  send(@Req() req: CfRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.run(req, 'POST /conversations/:id/messages', async (c) => {
      requireScope(c, 'messages:send');
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !isUuid(key)) throw Errors.badRequest('Send an Idempotency-Key header (a UUID) so a retried request never sends twice.');
      const b = (body ?? {}) as { text?: unknown; seenActivity?: unknown };
      const seen = typeof b.seenActivity === 'number' ? b.seenActivity : await this.inbox.currentActivity(c.actor, id);
      const m = await this.inbox.reply(c.actor, id, { text: b.text, seenActivity: seen, clientMessageId: key });
      return { id: (m as { id: string }).id, status: (m as { status: string }).status };
    });
  }

  @ApiKeyAuth() @Get('contacts')
  contacts(@Req() req: CfRequest, @Query() q: unknown) {
    return this.run(req, 'GET /contacts', async (c) => { requireScope(c, 'contacts:read'); return this.reads.contacts(c, q); });
  }

  @ApiKeyAuth() @Get('reports/ads')
  ads(@Req() req: CfRequest, @Query() q: unknown) {
    return this.run(req, 'GET /reports/ads', async (c) => { requireScope(c, 'reports:read'); return this.reports.ads(c.actor, q); });
  }
}

/** API keys and outgoing webhooks, managed in the app by owners and admins (api.manage, two-step sign-in). */
@Controller('v1/developers')
export class DevelopersController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService, @Inject(WebhookEndpointsService) private readonly hooks: WebhookEndpointsService) {}

  @RequirePermission('api.manage') @Get('keys')
  listKeys(@CurrentActor() actor: TenantActor) { return this.keys.list(actor); }
  @RequirePermission('api.manage') @Post('keys') @HttpCode(201)
  createKey(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.keys.create(actor, body); }
  @RequirePermission('api.manage') @Post('keys/:id/revoke') @HttpCode(200)
  revokeKey(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.keys.revoke(actor, id); }
  @RequirePermission('api.manage') @Get('keys/:id/log')
  keyLog(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.keys.log(actor, id); }

  @RequirePermission('api.manage') @Get('webhooks')
  listHooks(@CurrentActor() actor: TenantActor) { return this.hooks.list(actor); }
  @RequirePermission('api.manage') @Post('webhooks') @HttpCode(201)
  createHook(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.hooks.create(actor, body); }
  @RequirePermission('api.manage') @Patch('webhooks/:id')
  updateHook(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.hooks.update(actor, id, body); }
  @RequirePermission('api.manage') @Post('webhooks/:id/rotate') @HttpCode(200)
  rotateHook(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.hooks.rotate(actor, id); }
  @RequirePermission('api.manage') @Delete('webhooks/:id')
  deleteHook(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.hooks.remove(actor, id); }
  @RequirePermission('api.manage') @Get('webhooks/:id/deliveries')
  deliveries(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.hooks.deliveries(actor, id); }
  @RequirePermission('api.manage') @Post('deliveries/:id/resend') @HttpCode(201)
  resend(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.hooks.resend(actor, id); }
}

/** Guided setup (W2.7): checklist for everyone in the company; packs and drafts for those who manage these things. */
@Controller('v1/setup')
export class SetupController {
  constructor(@Inject(SetupService) private readonly setup: SetupService) {}

  @RequirePermission('tenant.read') @Get('checklist')
  checklist(@CurrentActor() actor: TenantActor) { return this.setup.checklist(actor); }

  @RequirePermission('tenant.read') @Get('packs')
  packs(@CurrentActor() actor: TenantActor) { return this.setup.packs(actor); }

  // Each part of a pack checks its own permission (tags, saved replies, knowledge) in the service.
  @RequirePermission('tenant.read') @Post('packs/:key/apply') @HttpCode(200)
  apply(@CurrentActor() actor: TenantActor, @Param('key') key: string) { return this.setup.applyPack(actor, key); }

  @RequirePermission('automations.manage') @Post('describe') @HttpCode(201)
  describe(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.setup.fromDescription(actor, body); }
}

@Controller('v1/conversations')
export class InboxController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService, @Inject(AiService) private readonly ai: AiService) {}

  /** AI assistance (W2.3): a summary and a suggested reply for the agent. Nothing is sent. */
  @RequirePermission('inbox.reply') @Post(':id/assist/summary') @HttpCode(200)
  assistSummary(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.ai.summarise(actor, id); }

  @RequirePermission('inbox.reply') @Post(':id/assist/suggest') @HttpCode(200)
  assistSuggest(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.ai.suggestReply(actor, id); }

  /** Explanations of AI results in this conversation (CF-EXT-021). */
  @RequirePermission('inbox.reply') @Get(':id/ai/:interactionId')
  aiExplanation(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Param('interactionId') iid: string) { return this.ai.interaction(actor, id, iid); }

  @RequirePermission('inbox.reply') @Get(':id/ai')
  aiExplanations(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.ai.interactions(actor, id); }

  @RequirePermission('inbox.reply') @Get()
  list(@CurrentActor() actor: TenantActor, @Query() q: unknown) {
    return this.inbox.list(actor, q);
  }

  @RequirePermission('inbox.reply') @Get(':id')
  get(@CurrentActor() actor: TenantActor, @Param('id') id: string) {
    return this.inbox.get(actor, id);
  }

  /** Resolves or reopens a conversation (expected version required). */
  @RequirePermission('inbox.reply') @Post(':id/status') @HttpCode(200)
  setStatus(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    return this.inbox.setStatus(actor, id, body);
  }

  @RequirePermission('inbox.reply') @Post(':id/assign') @HttpCode(200)
  assign(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    return this.inbox.assign(actor, id, body);
  }

  @RequirePermission('inbox.reply') @Post(':id/notes') @HttpCode(201)
  note(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    return this.inbox.addNote(actor, id, body);
  }

  @RequirePermission('inbox.reply') @Post(':id/reply') @HttpCode(201)
  reply(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    return this.inbox.reply(actor, id, body);
  }

  @RequirePermission('inbox.reply') @Post(':id/template') @HttpCode(201)
  sendTemplate(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    return this.inbox.sendTemplate(actor, id, body);
  }
  @RequirePermission('inbox.pause') @Post(':id/pause') @HttpCode(200)
  pause(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    return this.inbox.pause(actor, id, body);
  }

  /** The supervisor who paused, or anyone with inbox.pause, can release (checked in the service). */
  @RequirePermission('inbox.reply') @Delete(':id/pause') @HttpCode(200)
  release(@CurrentActor() actor: TenantActor, @Param('id') id: string) {
    return this.inbox.release(actor, id);
  }
}

@Controller('v1/messages')
export class MessagesController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService, @Inject(AiService) private readonly ai: AiService) {}

  /** AI translation of a message; the original is kept unchanged (CF-EXT-009). */
  @RequirePermission('inbox.reply') @Post(':id/translate') @HttpCode(200)
  translate(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.ai.translate(actor, id, body); }

  @RequirePermission('inbox.reply') @Post(':id/retry') @HttpCode(201)
  retry(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    return this.inbox.retry(actor, id, body);
  }
}

@Controller('v1/templates')
export class TemplatesController {
  constructor(@Inject(TemplatesService) private readonly templates: TemplatesService) {}

  @RequirePermission('inbox.reply') @Get()
  list(@CurrentActor() actor: TenantActor) {
    return this.templates.list(actor);
  }

  @RequirePermission('templates.manage') @Post() @HttpCode(201)
  create(@CurrentActor() actor: TenantActor, @Body() body: unknown) {
    return this.templates.create(actor, body);
  }

  /** Recovery: re-reads review status, quality and category from the provider. */
  @RequirePermission('templates.manage') @Post('sync') @HttpCode(200)
  sync(@CurrentActor() actor: TenantActor) {
    return this.templates.sync(actor);
  }
}

@Controller('v1/contacts')
export class ContactsController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService, @Inject(ContactImportService) private readonly imports: ContactImportService,
    @Inject(DEPS) private readonly deps: Deps) {}

  @RequirePermission('contacts.read') @Get()
  list(@CurrentActor() actor: TenantActor, @Query() q: unknown) { return listContacts(this.deps, actor, q); }

  /** Step 1 of an import: reads the file and shows what would happen to each row. Changes nothing. */
  @RequirePermission('contacts.import') @Post('imports') @HttpCode(201)
  previewImport(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.imports.preview(actor, body); }

  @RequirePermission('contacts.import') @Get('imports')
  listImports(@CurrentActor() actor: TenantActor) { return this.imports.list(actor); }

  @RequirePermission('contacts.import') @Post('imports/:id/commit') @HttpCode(200)
  commitImport(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.imports.commit(actor, id); }

  @RequirePermission('contacts.import') @Post('imports/:id/undo') @HttpCode(200)
  undoImport(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.imports.undo(actor, id); }

  @RequirePermission('contacts.write') @Post(':id/marketing-consent') @HttpCode(200)
  marketingConsent(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) {
    return this.inbox.setMarketingConsent(actor, id, body);
  }
}

@Controller('v1/campaigns')
export class CampaignsController {
  constructor(@Inject(CampaignsService) private readonly campaigns: CampaignsService) {}

  @RequirePermission('campaigns.manage') @Get()
  list(@CurrentActor() actor: TenantActor) { return this.campaigns.list(actor); }

  /** What would happen if the campaign started now: eligible recipients, exclusions by reason, samples, cost. */
  @RequirePermission('campaigns.manage') @Post('preview') @HttpCode(200)
  preview(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.campaigns.preview(actor, body); }

  @RequirePermission('campaigns.manage') @Post() @HttpCode(201)
  create(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.campaigns.create(actor, body); }

  @RequirePermission('campaigns.manage') @Get(':id')
  get(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.campaigns.get(actor, id); }

  @RequirePermission('campaigns.manage') @Post(':id/schedule') @HttpCode(200)
  schedule(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.campaigns.schedule(actor, id, body); }

  @RequirePermission('campaigns.manage') @Post(':id/pause') @HttpCode(200)
  pause(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.campaigns.pause(actor, id); }

  @RequirePermission('campaigns.manage') @Post(':id/resume') @HttpCode(200)
  resume(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.campaigns.resume(actor, id); }

  @RequirePermission('campaigns.manage') @Post(':id/cancel') @HttpCode(200)
  cancel(@CurrentActor() actor: TenantActor, @Param('id') id: string) { return this.campaigns.cancel(actor, id); }
}

@Controller('v1/suppressions')
export class SuppressionsController {
  constructor(@Inject(CampaignsService) private readonly campaigns: CampaignsService) {}

  @RequirePermission('campaigns.manage') @Get()
  list(@CurrentActor() actor: TenantActor) { return this.campaigns.listSuppressions(actor); }

  @RequirePermission('campaigns.manage') @Post() @HttpCode(201)
  add(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.campaigns.addSuppression(actor, body); }

  @RequirePermission('campaigns.manage') @Delete(':id') @HttpCode(204)
  async remove(@CurrentActor() actor: TenantActor, @Param('id') id: string) { await this.campaigns.removeSuppression(actor, id); }
}

@Controller('v1/tags')
export class TagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  /** Everyone who can reply sees the company's tags (to put them on conversations). */
  @RequirePermission('inbox.reply') @Get()
  list(@CurrentActor() actor: TenantActor) { return this.tags.list(actor); }

  @RequirePermission('tags.manage') @Post() @HttpCode(201)
  create(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.tags.create(actor, body); }

  @RequirePermission('tags.manage') @Patch(':id')
  update(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.tags.update(actor, id, body); }

  @RequirePermission('tags.manage') @Delete(':id') @HttpCode(204)
  async remove(@CurrentActor() actor: TenantActor, @Param('id') id: string) { await this.tags.remove(actor, id); }
}

@Controller('v1/conversations/:conversationId/tags')
export class ConversationTagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  @RequirePermission('inbox.reply') @Put(':tagId')
  add(@CurrentActor() actor: TenantActor, @Param('conversationId') c: string, @Param('tagId') t: string) { return this.tags.tagConversation(actor, c, t, true); }

  @RequirePermission('inbox.reply') @Delete(':tagId')
  remove(@CurrentActor() actor: TenantActor, @Param('conversationId') c: string, @Param('tagId') t: string) { return this.tags.tagConversation(actor, c, t, false); }
}

@Controller('v1/saved-replies')
export class SavedRepliesController {
  constructor(@Inject(SavedRepliesService) private readonly replies: SavedRepliesService) {}

  @RequirePermission('inbox.reply') @Get()
  list(@CurrentActor() actor: TenantActor) { return this.replies.list(actor); }

  @RequirePermission('saved_replies.manage') @Post() @HttpCode(201)
  create(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.replies.create(actor, body); }

  @RequirePermission('saved_replies.manage') @Patch(':id')
  update(@CurrentActor() actor: TenantActor, @Param('id') id: string, @Body() body: unknown) { return this.replies.update(actor, id, body); }

  @RequirePermission('saved_replies.manage') @Delete(':id') @HttpCode(204)
  async remove(@CurrentActor() actor: TenantActor, @Param('id') id: string) { await this.replies.remove(actor, id); }
}

@Controller('v1/inbox/assignment')
export class AssignmentController {
  constructor(@Inject(AssignmentService) private readonly assignment: AssignmentService) {}

  @RequirePermission('inbox.assign') @Get()
  get(@CurrentActor() actor: TenantActor) { return this.assignment.get(actor); }

  @RequirePermission('inbox.assign') @Put()
  update(@CurrentActor() actor: TenantActor, @Body() body: unknown) { return this.assignment.update(actor, body); }
}
