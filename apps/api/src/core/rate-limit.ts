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
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, rule.windowSeconds);
    if (count > rule.limit) throw Errors.tooManyRequests();
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
  forgotPerEmail: { name: 'forgot:email', limit: 5, windowSeconds: 60 * 60 },
} satisfies Record<string, RateRule>;
