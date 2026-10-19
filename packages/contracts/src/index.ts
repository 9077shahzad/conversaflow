/**
 * Request and response contracts shared by the API, the web app and (later) the public API docs.
 * One schema drives server-side validation and client types.
 */
import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
export const password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters');
const locale = z.enum(['en', 'ar']);
const otp = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
const token = z.string().min(20).max(200);

export const SignupRequest = z.object({
  email,
  password,
  fullName: z.string().trim().min(1).max(200),
  locale: locale.default('en'),
});
export const VerifyEmailRequest = z.object({ token });
export const LoginRequest = z.object({ email, password: z.string().min(1).max(128) });
export const MfaChallengeRequest = z.union([
  z.object({ code: otp }),
  z.object({ recoveryCode: z.string().trim().min(8).max(32) }),
]);
export const MfaConfirmRequest = z.object({ code: otp });
export const ForgotPasswordRequest = z.object({ email });
export const ResetPasswordRequest = z.object({ token, password });

export const CreateTenantRequest = z.object({
  legalName: z.string().trim().min(2).max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/, 'Use 3–40 lowercase letters, digits or hyphens'),
  country: z.string().regex(/^[A-Z]{2}$/),
  timezone: z.string().min(3).max(64),
  currency: z.string().regex(/^[A-Z]{3}$/),
  locale: locale.default('en'),
  planCode: z.enum(['starter', 'growth', 'business', 'enterprise']).default('starter'),
});
export const UpdateTenantRequest = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    timezone: z.string().min(3).max(64),
    locale,
  })
  .partial();
export const SwitchTenantRequest = z.object({ tenantId: z.string().uuid() });

export const InviteRequest = z.object({ email, roleKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) });
export const AcceptInvitationRequest = z.object({ token });
export const SetMemberRolesRequest = z.object({
  roleKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/)).min(1).max(10),
});
export const CreateRoleRequest = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().trim().min(2).max(80),
  permissions: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).min(1).max(100),
});

export type SignupRequest = z.infer<typeof SignupRequest>;
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequest>;
export type InviteRequest = z.infer<typeof InviteRequest>;
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;

/** Standard error body returned by every endpoint. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
