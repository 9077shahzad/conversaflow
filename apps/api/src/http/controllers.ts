/// <reference types="multer" />
import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { MfaChallengeRequest, MfaConfirmRequest, VerifyEmailRequest } from '@conversaflow/contracts';
import type { AuthSession, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from '../modules/audit.service';
import { AuthService, type ClientInfo } from '../modules/auth.service';
import { EntitlementsService } from '../modules/entitlements.service';
import { FilesService } from '../modules/files.service';
import { MembersService } from '../modules/members.service';
import { TenantsService } from '../modules/tenants.service';
import { AllowPendingMfa, CurrentActor, CurrentSession, Public, RequirePermission, SESSION_COOKIE, type CfRequest } from './guard';

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

  @Post('mfa/totp/confirm')
  totpConfirm(@Body() body: unknown, @CurrentSession() session: AuthSession) {
    return this.auth.confirmTotp(session, parse(MfaConfirmRequest, body).code);
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
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(TenantsService) private readonly tenants: TenantsService) {}

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
    return this.audit.list(actor, limit ? Number(limit) : 50, before ? Number(before) : undefined);
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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024, files: 1 } }))
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
