#!/usr/bin/env node
/**
 * Dependency audit for ALL packages (production, development and build tools).
 * Fails on: any high or critical advisory anywhere; any advisory at all in production dependencies;
 * unless it is listed in docs/security/audit-exceptions.json with an unexpired date.
 * Prints a report of every advisory with its relevance.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = (args) => {
  try { return execFileSync('pnpm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return e.stdout; } // pnpm audit exits non-zero when it finds anything
};
const all = JSON.parse(run(['audit', '--json']));
const prod = JSON.parse(run(['audit', '--json', '--prod']));
const prodIds = new Set(Object.values(prod.advisories ?? {}).map((a) => a.github_advisory_id));
const { exceptions } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../docs/security/audit-exceptions.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const rows = Object.values(all.advisories ?? {}).map((a) => {
  const id = a.github_advisory_id;
  const scope = prodIds.has(id) ? 'production' : 'development/build only';
  const ex = exceptions.find((e) => e.advisory === id && e.package === a.module_name);
  const blocking = scope === 'production' || ['high', 'critical'].includes(a.severity);
  let outcome = blocking ? 'FAIL' : 'reported (moderate/low, development only)';
  if (blocking && ex) outcome = ex.expires >= today ? `excepted until ${ex.expires} (${ex.status}${ex.approvedBy ? `, ${ex.approvedBy}` : ''})` : `FAIL (exception expired ${ex.expires})`;
  const paths = [...new Set(a.findings.flatMap((f) => f.paths))].slice(0, 3).join('; ');
  return { id, pkg: a.module_name, severity: a.severity, scope, fix: a.patched_versions, paths, outcome, title: a.title };
});

console.log(`Dependency audit (all packages), ${today}`);
console.log(`Totals: ${JSON.stringify(all.metadata?.vulnerabilities ?? {})}; production: ${JSON.stringify(prod.metadata?.vulnerabilities ?? {})}`);
if (!rows.length) console.log('No known vulnerabilities found in any dependency.');
for (const r of rows) {
  console.log(`- ${r.severity.toUpperCase()} ${r.pkg} ${r.id} [${r.scope}] fix: ${r.fix} -> ${r.outcome}`);
  console.log(`    ${r.title}`);
  console.log(`    via ${r.paths}`);
}
const failed = rows.filter((r) => r.outcome.startsWith('FAIL'));
for (const e of exceptions) if (!rows.some((r) => r.id === e.advisory)) console.log(`- exception ${e.advisory} (${e.package}) no longer needed; remove it`);
if (failed.length) { console.error(`Dependency audit FAILED: ${failed.length} blocking advisory(ies).`); process.exit(1); }
console.log('Dependency audit passed.');
