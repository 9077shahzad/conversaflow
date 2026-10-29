import type { ZodType } from 'zod';
import { Errors } from './errors';

export function parse<T>(schema: ZodType<T, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Errors.badRequest(
      'Some fields need attention.',
      result.error.issues.map((i) => ({ field: i.path.map(String).join('.'), message: i.message })),
    );
  }
  return result.data;
}
