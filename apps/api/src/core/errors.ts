/** A failure the caller is allowed to see. Everything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details),
  unauthenticated: () => new AppError(401, 'unauthenticated', 'Please sign in.'),
  invalidCredentials: () => new AppError(401, 'invalid_credentials', 'Email or password is incorrect.'),
  mfaRequired: () => new AppError(401, 'mfa_required', 'Enter your authentication code to continue.'),
  forbidden: (message = 'You do not have permission to do this.') => new AppError(403, 'forbidden', message),
  mfaEnrollmentRequired: () =>
    new AppError(403, 'mfa_enrollment_required', 'Set up two-step verification before doing this.'),
  companyRequiresMfa: () =>
    new AppError(403, 'mfa_enrollment_required', 'This company requires two-step verification for everyone. Set it up to continue.'),
  emailNotVerified: () => new AppError(403, 'email_not_verified', 'Please verify your email address first.'),
  noActiveTenant: () => new AppError(403, 'no_active_company', 'Choose a company workspace first.'),
  // 404 is used for records in other companies too, so their existence is never revealed.
  notFound: (what = 'Record') => new AppError(404, 'not_found', `${what} not found.`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  limitReached: (key: string, limit: number) =>
    new AppError(402, 'limit_reached', `Your plan limit for ${key.replace(/_/g, ' ')} (${limit}) has been reached.`, { key, limit }),
  tooManyRequests: () => new AppError(429, 'rate_limited', 'Too many attempts. Please wait and try again.'),
  invalidLink: () => new AppError(403, 'invalid_link', 'This link is invalid or has expired.'),
};
