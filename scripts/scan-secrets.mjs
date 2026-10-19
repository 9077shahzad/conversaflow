#!/usr/bin/env node
// Fails if a tracked file looks like it contains a real credential. Complements gitleaks in CI.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Stripe live key', /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/],
  ['Meta access token', /\bEAA[A-Za-z0-9]{60,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Anthropic/OpenAI key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['password in URL', /:\/\/[^:\s/]+:(?!change-me|ci-|\$|owner-|app-)[^@\s/]{8,}@(?!localhost|127\.0\.0\.1)/],
];

const files = execSync('git ls-files -co --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.endsWith('pnpm-lock.yaml') && !/\.(png|jpg|ico|woff2?)$/.test(f));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) findings.push(`${file}:${i + 1} looks like a ${name}`);
  });
}

if (findings.length) {
  console.error(`Possible secrets found:\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} files checked).`);
