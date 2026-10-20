#!/usr/bin/env node
/**
 * Dependency audit for ALL packages (production, development and build tools).
 *
 * Fails when:
 *   - the audit cannot run or returns no usable result (registry unreachable, error reply, empty output);
 *   - any high or critical advisory exists anywhere;
 *   - any advisory exists in production dependencies;
 * unless an APPROVED, unexpired exception in docs/security/audit-exceptions.json covers it, for its recorded scope,
 * with a named owner and a review date that is before the expiry and not yet passed.
 * Exceptions marked "proposed" never pass in strict mode (CI). `--allow-proposed` lets local evidence runs continue
 * past a proposed exception; the report then says so explicitly.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowProposed = process.argv.includes('--allow-proposed');
const fail = (msg) => {
  console.error(`Dependency audit FAILED: ${msg}`);
  process.exit(1);
};

function audit(args) {
  let out;
  try {
    out = execFileSync('pnpm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = e.stdout;
  } // pnpm audit exits non-zero when it finds advisories; the JSON is still on stdout
  if (!out || !out.trim()) fail(`no output from "pnpm ${args.join(' ')}"`);
  let json;
  try {
    json = JSON.parse(out);
  } catch {
    fail(`unreadable output from "pnpm ${args.join(' ')}"`);
  }
  if (json.error)
    fail(
      `"pnpm ${args.join(' ')}" reported an error: ${json.error.code ?? ''} ${json.error.message ?? JSON.stringify(json.error)}`,
    );
  if (!json.advisories || !json.metadata?.vulnerabilities)
    fail(`"pnpm ${args.join(' ')}" returned no advisory data`);
  return json;
}

/** Decides each advisory's outcome. Exported for the unit tests in scripts/audit-deps.test.mjs. */
export function evaluate(advisories, prodIds, exceptions, today, allowProposed) {
  return Object.values(advisories).map((a) => {
    const id = a.github_advisory_id;
    const scope = prodIds.has(id) ? 'production' : 'development';
    const blocking = scope === 'production' || ['high', 'critical'].includes(a.severity);
    const ex = exceptions.find((e) => e.advisory === id && e.package === a.module_name);
    let outcome = blocking ? 'FAIL' : 'reported (moderate/low, development only)';
    if (blocking && ex) {
      if (ex.scope !== scope)
        outcome = `FAIL (exception covers ${ex.scope} only; found in ${scope})`;
      else if (ex.expires < today) outcome = `FAIL (exception expired ${ex.expires})`;
      else if (!ex.owner || !ex.reviewBy || ex.reviewBy > ex.expires)
        outcome = 'FAIL (exception lacks an owner or a review date before expiry)';
      else if (ex.reviewBy < today)
        outcome = `FAIL (exception review overdue since ${ex.reviewBy})`;
      else if (ex.status === 'approved' && ex.approvedBy)
        outcome = `excepted until ${ex.expires}, review by ${ex.reviewBy} (owner ${ex.owner}, approved by ${ex.approvedBy})`;
      else if (allowProposed)
        outcome = `PROPOSED exception, not yet approved (allowed for this local run only)`;
      else outcome = 'FAIL (exception proposed, awaiting owner approval)';
    }
    const paths = [...new Set(a.findings.flatMap((f) => f.paths))].slice(0, 3).join('; ');
    return {
      id,
      pkg: a.module_name,
      severity: a.severity,
      scope,
      fix: a.patched_versions,
      paths,
      outcome,
      title: a.title,
    };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const all = audit(['audit', '--json']);
  const prod = audit(['audit', '--json', '--prod']);
  const prodIds = new Set(Object.values(prod.advisories).map((a) => a.github_advisory_id));
  const exFile = join(
    dirname(fileURLToPath(import.meta.url)),
    '../docs/security/audit-exceptions.json',
  );
  const { exceptions } = JSON.parse(readFileSync(exFile, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  const rows = evaluate(all.advisories, prodIds, exceptions, today, allowProposed);
  console.log(
    `Dependency audit (all packages), ${today}${allowProposed ? ' — local run, proposed exceptions allowed' : ' — strict'}`,
  );
  console.log(
    `Totals: ${JSON.stringify(all.metadata.vulnerabilities)}; production: ${JSON.stringify(prod.metadata.vulnerabilities)}`,
  );
  if (!rows.length) console.log('No known vulnerabilities found in any dependency.');
  for (const r of rows) {
    console.log(
      `- ${r.severity.toUpperCase()} ${r.pkg} ${r.id} [${r.scope}] fix: ${r.fix} -> ${r.outcome}`,
    );
    console.log(`    ${r.title}`);
    console.log(`    via ${r.paths}`);
  }
  for (const e of exceptions)
    if (!rows.some((r) => r.id === e.advisory))
      console.log(`- exception ${e.advisory} (${e.package}) is no longer needed; remove it`);
  const failed = rows.filter((r) => r.outcome.startsWith('FAIL'));
  if (failed.length) fail(`${failed.length} blocking advisory(ies).`);
  console.log(
    rows.some((r) => r.outcome.startsWith('PROPOSED'))
      ? 'Dependency audit passed for this local run, with a proposed exception awaiting approval.'
      : 'Dependency audit passed.',
  );
}
