/**
 * Prints every interface string in English and Arabic, flattened by key, as JSON.
 * Usage: npx tsx scripts/arabic-review/export-strings.ts [path/to/i18n.ts]   (default: apps/web/lib/i18n.ts)
 */
import { resolve } from 'node:path';

const source = resolve(process.argv[2] ?? 'apps/web/lib/i18n.ts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dictionaries } = require(source) as { dictionaries: { en: unknown; ar: unknown } };

type Tree = { [k: string]: string | Tree };
const flat = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? { ...acc, [key]: v } : { ...acc, ...flat(v, key) };
  }, {});
const en = flat(dictionaries.en as unknown as Tree);
const ar = flat(dictionaries.ar as unknown as Tree);
console.log(JSON.stringify(Object.keys(en).map((key) => ({ key, en: en[key], ar: ar[key] ?? '' }))));
