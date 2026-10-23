import {
  CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthSession, Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { AuthService } from '../modules/auth.service';
import { loadActor, permissionsRequiringMfa, type Permission } from '../modules/rbac';
import { DEPS } from './tokens';

export const SESSION_COOKIE = 'cf_session';
const PUBLIC = 'cf:public';
const PERMISSION = 'cf:permission';
const ALLOW_PENDING_MFA = 'cf:allow-pending-mfa';
const SIGNED_WEBHOOK = 'cf:signed-webhook';
const API_KEY = 'cf:api-key';

/** No sign-in needed (sign-up, login, password reset). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Requires an active company and this permission there. Checked on the server for every request. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);
/**
 * A provider webhook: no session and no CSRF header, because the caller is a server, not a browser. The handler MUST
 * verify the provider's signature over the raw body before reading anything (CF-EXT-001).
 */
export const SignedWebhook = () => SetMetadata(SIGNED_WEBHOOK, true);
/**
 * The public API (W2.8): authenticated by an API key in the Authorization header, checked by the handler on every
 * request. No cookies or session are used, so the browser cross-site checks do not apply.
 */
export const ApiKeyAuth = () => SetMetadata(API_KEY, true);
/** Reachable while the second sign-in step (MFA) is still outstanding. */
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);

export interface CfRequest extends Request {
  cfSession?: AuthSession;
  cfActor?: TenantActor;
}

export const CurrentSession = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const s = ctx.switchToHttp().getRequest<CfRequest>().cfSession;
  if (!s) throw Errors.unauthenticated();
  return s;
});
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const a = ctx.switchToHttp().getRequest<CfRequest>().cfActor;
  if (!a) throw Errors.noActiveTenant();
  return a;
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DEPS) private readonly deps: Deps,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CfRequest>();
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);

    // Cross-site request forgery: state-changing calls must carry a custom header (which browsers will not
    // send cross-site without a CORS pre-flight we do not allow) and, when present, our own Origin.
    if (meta<boolean>(SIGNED_WEBHOOK) || meta<boolean>(API_KEY)) return true;
    if (!SAFE_METHODS.has(req.method)) {
      if (req.headers['x-requested-with'] !== 'conversaflow') throw new AppError(403, 'csrf', 'Request blocked.');
      const origin = req.headers.origin;
      if (origin && origin !== this.deps.config.APP_ORIGIN) throw new AppError(403, 'csrf', 'Request blocked.');
    }

    if (meta<boolean>(PUBLIC)) return true;

    const session = await this.auth.authenticate(req.cookies?.[SESSION_COOKIE]);
    if (!session) throw Errors.unauthenticated();
    req.cfSession = session;

    if (session.userHasMfa && !session.mfaVerified && !meta<boolean>(ALLOW_PENDING_MFA)) throw Errors.mfaRequired();

    const permission = meta<Permission>(PERMISSION);
    if (!permission) return true;

    if (!session.activeTenantId) throw Errors.noActiveTenant();
    const actor = await loadActor(this.deps.db, session.activeTenantId, session.userId, req.ip);
    if (!actor) throw Errors.forbidden('You are no longer a member of this company.');
    // Pilot companies: every member must have two-step sign-in set up and verified in this session, for every
    // company request, whatever the permission (owner decision 20 Oct 2026).
    if (actor.requiresMfa && !(session.userHasMfa && session.mfaVerified)) throw Errors.companyRequiresMfa();
    if (!actor.permissions.has(permission)) throw Errors.forbidden();
    if ((await permissionsRequiringMfa(this.deps.db)).has(permission) && !(session.userHasMfa && session.mfaVerified)) {
      throw Errors.mfaEnrollmentRequired();
    }
    req.cfActor = actor;
    return true;
  }
}
