import type Redis from 'ioredis';
import { Errors } from './errors';

export interface RateRule {
  /** e.g. "login:email" */
  name: string;
  limit: number;
  windowSeconds: number;
}

/** Fixed-window limiter in Redis, shared by every API instance. */
export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(rule: RateRule, subject: string): Promise<void> {
    const key = `rl:${rule.name}:${subject}`;
    // One atomic round trip: create the window with its expiry if missing, then count.
    const res = await this.redis.multi().set(key, 0, 'EX', rule.windowSeconds, 'NX').incr(key).exec();
    const count = Number(res?.[1]?.[1] ?? 0);
    if (count > rule.limit) throw Errors.tooManyRequests();
  }

  /** Refuses once the limit is reached, without counting this request. */
  async check(rule: RateRule, subject: string): Promise<void> {
    const count = Number((await this.redis.get(`rl:${rule.name}:${subject}`)) ?? 0);
    if (count >= rule.limit) throw Errors.tooManyRequests();
  }

  async reset(rule: RateRule, subject: string): Promise<void> {
    await this.redis.del(`rl:${rule.name}:${subject}`);
  }
}

export const RATE_RULES = {
  loginPerEmail: { name: 'login:email', limit: 10, windowSeconds: 15 * 60 },
  loginPerIp: { name: 'login:ip', limit: 50, windowSeconds: 15 * 60 },
  signupPerIp: { name: 'signup:ip', limit: 20, windowSeconds: 60 * 60 },
  mfaPerSession: { name: 'mfa:session', limit: 6, windowSeconds: 15 * 60 },
  // Per user too: signing in again must not reset the allowance for guessing codes.
  mfaPerUser: { name: 'mfa:user', limit: 10, windowSeconds: 60 * 60 },
  forgotPerEmail: { name: 'forgot:email', limit: 5, windowSeconds: 60 * 60 },
  // Customer links (W2.4): all requests per address, wrong links per address, and requests per link.
  customerLinkPerIp: { name: 'clink:ip', limit: 300, windowSeconds: 15 * 60 },
  customerLinkFailPerIp: { name: 'clink:fail', limit: 20, windowSeconds: 60 * 60 },
  customerLinkPerLink: { name: 'clink:link', limit: 120, windowSeconds: 15 * 60 },
} satisfies Record<string, RateRule>;
