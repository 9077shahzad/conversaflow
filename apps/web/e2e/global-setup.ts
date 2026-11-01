import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Seeds a synthetic demo company through the real services and stores its sign-in details for the tests. */
export default async function globalSetup() {
  const out = execFileSync('node', [join(__dirname, '../../api/dist/verification/seed-demo.js')], {
    encoding: 'utf8',
    // The seed refuses to run without these (review of the dashboards, finding 6).
    env: { ...process.env, ALLOW_DEMO_SEED: '1', DEMO_SEED_PLATFORM_OWNER: '1' },
  });
  const line = out.trim().split('\n').pop()!;
  writeFileSync(join(__dirname, '.demo.json'), line);
}
