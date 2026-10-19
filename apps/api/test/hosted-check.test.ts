/**
 * Dry run of the hosted file-revocation check against a real HTTP server on this machine.
 * The hosted run itself is pending a deployment environment; this proves the check works and would catch a failure.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { FilesService } from '../src/modules/files.service';
import { runFileRevocationCheck } from '../src/verification/file-revocation-check';
import { addMember, enableMfa, newCompany, newUser, nextTotp, PASSWORD, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let baseUrl: string;
let owner: Client;
let member: Client;
let outsider: Client;

beforeAll(async () => {
  t = await startApp();
  await t.app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  owner = await newUser(t, 'hostowner');
  await newCompany(owner, 'hosted');
  await enableMfa(owner);
  member = await addMember(t, owner, 'hostmember', 'agent');
  outsider = await newUser(t, 'hostoutsider');
  await newCompany(outsider, 'elsewhere');
  await nextTotp(owner); // the enrolment code is spent; sign-in needs the next one
}, 90_000);
afterAll(() => t?.close());

describe('hosted file-revocation check (local dry run)', () => {
  it('every step passes against a correct server, including removal', async () => {
    const result = await runFileRevocationCheck({
      baseUrl,
      owner: { email: owner.email, password: PASSWORD, totpSecret: owner.mfaSecret },
      member: { email: member.email, password: PASSWORD },
      outsider: { email: outsider.email, password: PASSWORD },
      includeRemoval: true,
    });
    const failed = result.steps.filter((s) => !s.pass);
    expect(failed).toEqual([]);
    expect(result.steps.length).toBeGreaterThanOrEqual(15);
  }, 60_000);

  it('the check catches a server that fails to revoke access (deliberately broken download)', async () => {
    const original = FilesService.prototype.download;
    // Fault injection: a download that trusts the link alone and skips the membership/permission re-check.
    FilesService.prototype.download = async function (this: FilesService, _session, token) {
      const claims = (this as unknown as { verifyLink(t: string): { f: string; t: string; u: string } }).verifyLink(token);
      const deps = (this as unknown as { deps: TestApp['deps'] }).deps;
      return withContext(deps.db, { tenantId: claims.t, userId: claims.u }, async (tx) => {
        const r = (await tx.query('SELECT storage_key, original_name, content_type FROM files WHERE id = $1', [claims.f])).rows[0];
        return { data: await deps.storage.get(r.storage_key), name: r.original_name, contentType: r.content_type };
      });
    };
    try {
      const member2 = await addMember(t, owner, 'hostmember2', 'agent');
      await nextTotp(owner);
      const result = await runFileRevocationCheck({
        baseUrl,
        owner: { email: owner.email, password: PASSWORD, totpSecret: owner.mfaSecret },
        member: { email: member2.email, password: PASSWORD },
        outsider: { email: outsider.email, password: PASSWORD },
      });
      expect(result.pass).toBe(false);
      expect(result.steps.find((s) => s.step === 'existing link refused after permission removed')).toMatchObject({ pass: false, actual: '200' });
    } finally {
      FilesService.prototype.download = original;
    }
  }, 90_000);
});
