/**
 * Hosted verification: file-access revocation (pre-pilot item 4).
 *
 * Runs against a deployed environment over HTTPS using three pre-provisioned TEST accounts:
 *   owner    — Owner of company A, with two-step verification
 *   member   — Agent in company A
 *   outsider — member of a different company B
 * It proves, end to end through the real network path (load balancer, storage, scanner):
 *   access works while permitted, is refused after the member loses permission, is refused to outsiders and
 *   anonymous callers, and the file bytes and record are unchanged throughout.
 *
 * CLI:  BASE_URL=... OWNER_EMAIL=... OWNER_PASSWORD=... OWNER_TOTP_SECRET=... MEMBER_EMAIL=... MEMBER_PASSWORD=...
 *       OUTSIDER_EMAIL=... OUTSIDER_PASSWORD=... [INCLUDE_REMOVAL=1] node dist/verification/file-revocation-check.js
 * Never point it at production customer accounts; it uploads a small random test file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';

export interface Account {
  email: string;
  password: string;
  totpSecret?: string;
}
export interface CheckInput {
  baseUrl: string;
  owner: Account;
  member: Account;
  outsider: Account;
  includeRemoval?: boolean;
}
export interface StepResult {
  step: string;
  expected: string;
  actual: string;
  pass: boolean;
}

class Session {
  private cookie = '';
  constructor(private readonly base: string) {}

  async request(method: string, path: string, body?: unknown, raw?: FormData): Promise<Response> {
    const headers: Record<string, string> = { 'X-Requested-With': 'conversaflow' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(new URL(path, this.base), {
      method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    return res;
  }

  async signIn(a: Account): Promise<void> {
    const res = await this.request('POST', '/v1/auth/login', { email: a.email, password: a.password });
    if (res.status !== 200) throw new Error(`sign-in failed for ${a.email}: ${res.status}`);
    const { mfaRequired } = (await res.json()) as { mfaRequired: boolean };
    if (mfaRequired) {
      if (!a.totpSecret) throw new Error(`${a.email} needs a TOTP secret`);
      const mfa = await this.request('POST', '/v1/auth/mfa/challenge', { code: authenticator.generate(a.totpSecret) });
      if (mfa.status !== 204) throw new Error(`MFA failed for ${a.email}: ${mfa.status}`);
    }
  }
}

const sha = (b: Buffer | ArrayBuffer) => createHash('sha256').update(Buffer.from(b as ArrayBuffer)).digest('hex');

export async function runFileRevocationCheck(input: CheckInput): Promise<{ pass: boolean; steps: StepResult[] }> {
  const steps: StepResult[] = [];
  const record = (step: string, expected: string, actual: string | number) => {
    const a = String(actual);
    steps.push({ step, expected, actual: a, pass: a === expected });
  };

  const owner = new Session(input.baseUrl);
  const member = new Session(input.baseUrl);
  const outsider = new Session(input.baseUrl);
  const anonymous = new Session(input.baseUrl);
  await owner.signIn(input.owner);
  await member.signIn(input.member);
  await outsider.signIn(input.outsider);

  const members = (await (await owner.request('GET', '/v1/members')).json()) as Array<{ id: string; email: string; roles: string[] }>;
  const target = members.find((m) => m.email.toLowerCase() === input.member.email.toLowerCase());
  if (!target) throw new Error('member account is not in the owner\'s company');
  const originalRoles = target.roles;

  // 1. Owner uploads a random test file.
  const content = randomBytes(2048);
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), `revocation-check-${Date.now()}.txt`);
  const up = await owner.request('POST', '/v1/files', undefined, form);
  record('owner uploads a test file', '201', up.status);
  const file = (await up.json()) as { id: string; status: string; sizeBytes: number; name: string };
  record('file passes the malware scan', 'available', file.status);

  // 2. Member can link and download while permitted.
  const linkRes = await member.request('POST', `/v1/files/${file.id}/link`);
  record('member creates a download link while permitted', '201', linkRes.status);
  const link = ((await linkRes.json()) as { url: string }).url;
  const dl = await member.request('GET', link);
  record('member downloads while permitted', '200', dl.status);
  record('downloaded bytes match the upload', sha(content), sha(await dl.arrayBuffer()));

  // 3. Outsider and anonymous are refused.
  record('outsider cannot read the file record', '404', (await outsider.request('GET', `/v1/files/${file.id}`)).status);
  record('outsider cannot use the member\'s link', '403', (await outsider.request('GET', link)).status);
  record('anonymous caller cannot use the link', '401', (await anonymous.request('GET', link)).status);

  // 4. Member loses files.read: the existing link and new links are refused at once.
  const demote = await owner.request('PUT', `/v1/members/${target.id}/roles`, { roleKeys: ['analyst'] });
  record('owner removes the member\'s file permission', '204', demote.status);
  record('existing link refused after permission removed', '403', (await member.request('GET', link)).status);
  record('new link refused after permission removed', '403', (await member.request('POST', `/v1/files/${file.id}/link`)).status);

  // 5. Restore the member's original roles (leaves the test accounts as found).
  const restore = await owner.request('PUT', `/v1/members/${target.id}/roles`, { roleKeys: originalRoles });
  record('owner restores the member\'s roles', '204', restore.status);

  // 6. Optional: removal from the company also revokes access (destructive for the test account).
  if (input.includeRemoval) {
    const relink = (await (await member.request('POST', `/v1/files/${file.id}/link`)).json()) as { url: string };
    record('owner removes the member', '204', (await owner.request('DELETE', `/v1/members/${target.id}`)).status);
    record('removed member\'s link refused', '403', (await member.request('GET', relink.url)).status);
    record('removed member cannot list files', '403', (await member.request('GET', '/v1/files')).status);
  }

  // 7. Protected data unchanged: same bytes, same record.
  const ownerLink = ((await (await owner.request('POST', `/v1/files/${file.id}/link`)).json()) as { url: string }).url;
  const again = await owner.request('GET', ownerLink);
  record('file bytes unchanged afterwards', sha(content), sha(await again.arrayBuffer()));
  const meta = (await (await owner.request('GET', `/v1/files/${file.id}`)).json()) as typeof file;
  record('file record unchanged afterwards', JSON.stringify([file.name, file.sizeBytes, 'available']),
    JSON.stringify([meta.name, meta.sizeBytes, meta.status]));

  return { pass: steps.every((s) => s.pass), steps };
}

if (require.main === module) {
  const e = process.env;
  const need = (k: string) => {
    if (!e[k]) throw new Error(`${k} is required`);
    return e[k]!;
  };
  runFileRevocationCheck({
    baseUrl: need('BASE_URL'),
    owner: { email: need('OWNER_EMAIL'), password: need('OWNER_PASSWORD'), totpSecret: need('OWNER_TOTP_SECRET') },
    member: { email: need('MEMBER_EMAIL'), password: need('MEMBER_PASSWORD'), totpSecret: e.MEMBER_TOTP_SECRET },
    outsider: { email: need('OUTSIDER_EMAIL'), password: need('OUTSIDER_PASSWORD'), totpSecret: e.OUTSIDER_TOTP_SECRET },
    includeRemoval: e.INCLUDE_REMOVAL === '1',
  }).then(
    (r) => {
      console.log(JSON.stringify({ checkedAt: new Date().toISOString(), baseUrl: e.BASE_URL, ...r }, null, 2));
      process.exit(r.pass ? 0 : 1);
    },
    (err) => {
      console.error(err.message);
      process.exit(2);
    },
  );
}
