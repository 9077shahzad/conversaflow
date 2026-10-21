import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The permission keys of the first release, read from migration 0003 itself (SR-1 tests). */
export function firstReleasePermissions(): Set<string> {
  const sql = readFileSync(join(__dirname, '../../../packages/database/migrations/0003_tenancy_rbac.sql'), 'utf8');
  const block = sql.slice(sql.indexOf('INSERT INTO permissions'));
  return new Set([...block.slice(0, block.indexOf(';')).matchAll(/\('([a-z_.]+)'/g)].map((m) => m[1]!));
}
