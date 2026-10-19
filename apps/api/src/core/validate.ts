import type { ZodType, ZodTypeDef } from 'zod';
import { Errors } from './errors';

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Errors.badRequest(
      'Some fields need attention.',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
