/**
 * Company isolation through the API: records and files.
 * A user of company B tries every route to company A's members, settings, audit trail and files.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmac } from '../src/core/crypto';
import { addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let a: Client; // owner of company A
let b: Client; // owner of company B
let tenantA: string;
let tenantB: string;
let memberOfA: string;
let fileOfA: string;
let linkOfA: string;
const SECRET = Buffer.from('Confidential price list of company A');

beforeAll(async () => {
  t = await startApp();
  a = await newUser(t, 'acme');
  b = await newUser(t, 'bolt');
  tenantA = await newCompany(a, 'acme');
  tenantB = await newCompany(b, 'bolt');
  await enableMfa(a);
  await enableMfa(b);
  await addMember(t, a, 'acme-agent', 'agent');
  memberOfA = (await a.get('/v1/members').expect(200)).body.find((m: { roles: string[] }) => m.roles.includes('agent')).id;
  fileOfA = (await a.upload('prices.txt', 'text/plain', SECRET).expect(201)).body.id;
  linkOfA = (await a.post(`/v1/files/${fileOfA}/link`).expect(201)).body.url;
});
afterAll(() => t?.close());

describe('records: company B cannot reach company A through the API', () => {
  it("B cannot read A's member by id (404, so A's records are not even confirmed to exist)", async () => {
    const res = await b.get(`/v1/members/${memberOfA}`).expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it("B cannot change roles of, or remove, A's member", async () => {
    await b.put(`/v1/members/${memberOfA}/roles`, { roleKeys: ['admin'] }).expect(404);
    await b.delete(`/v1/members/${memberOfA}`).expect(404);
    const stillThere = (await a.get(`/v1/members/${memberOfA}`).expect(200)).body;
    expect(stillThere.roles).toEqual(['agent']);
    expect(stillThere.status).toBe('active');
  });

  it("B cannot switch its session into company A", async () => {
    await b.post('/v1/me/active-tenant', { tenantId: tenantA }).expect(404);
    expect((await b.get('/v1/tenant').expect(200)).body.id).toBe(tenantB);
  });

  it("B's lists contain nothing from A", async () => {
    const members = (await b.get('/v1/members').expect(200)).body;
    expect(members.map((m: { email: string }) => m.email)).toEqual([b.email]);
    const files = (await b.get('/v1/files').expect(200)).body;
    expect(files).toEqual([]);
    const audit = (await b.get('/v1/audit-events').expect(200)).body as Array<{ actorUserId: string; targetId: string }>;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((e) => e.actorUserId === b.userId)).toBe(true); // only B's own actions
    expect(audit.map((e) => e.targetId)).not.toContain(fileOfA);
    expect(audit.map((e) => e.targetId)).not.toContain(tenantA);
    expect((await b.get('/v1/me/tenants').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([tenantB]);
  });

  it('a tenant id smuggled in the request body or query is ignored', async () => {
    await b.patch(`/v1/tenant?tenantId=${tenantA}`, { legalName: 'Hijacked', tenantId: tenantA }).expect(200);
    expect((await a.get('/v1/tenant').expect(200)).body.legalName).toBe('acme Trading LLC');
    expect((await b.get('/v1/tenant').expect(200)).body.legalName).toBe('Hijacked');
  });
});

describe('files: company B cannot reach company A files', () => {
  it("B cannot read A's file details or create a download link for it", async () => {
    await b.get(`/v1/files/${fileOfA}`).expect(404);
    await b.post(`/v1/files/${fileOfA}/link`).expect(404);
  });

  it("B cannot download with A's valid link", async () => {
    const res = await b.get(linkOfA).expect(403);
    expect(res.body.error.code).toBe('invalid_link');
    expect(res.text).not.toContain(SECRET.toString());
  });

  it("A's link does not work without signing in", async () => {
    const { default: request } = await import('supertest');
    await request(t.app.getHttpServer()).get(linkOfA).expect(401);
  });

  it('A can download its own file with the link and gets the exact bytes', async () => {
    const res = await a.get(linkOfA).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(Buffer.compare(res.body as Buffer, SECRET)).toBe(0);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a tampered link is refused (signature check)', async () => {
    const [path, token] = linkOfA.split('?token=');
    const [payload] = token!.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, u: b.userId, t: tenantB })).toString('base64url');
    await b.get(`${path}?token=${forged}.${token!.split('.')[1]}`).expect(403);
  });

  it('an expired link is refused, even when correctly signed', async () => {
    const claims = { f: fileOfA, t: tenantA, u: a.userId, e: Math.floor(Date.now() / 1000) - 5 };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = hmac(t.deps.keys.fileLinks, payload).toString('base64url');
    await a.get(`/v1/files/download?token=${payload}.${sig}`).expect(403);
  });

  it("a correctly signed link naming B's company cannot open A's file", async () => {
    // Even if a link could be minted for B's company with A's file id, RLS hides A's row in B's context.
    const claims = { f: fileOfA, t: tenantB, u: b.userId, e: Math.floor(Date.now() / 1000) + 60 };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = hmac(t.deps.keys.fileLinks, payload).toString('base64url');
    const res = await b.get(`/v1/files/download?token=${payload}.${sig}`).expect(404);
    expect(res.text).not.toContain(SECRET.toString());
  });

  it("files are stored inside the owning company's folder, and unsafe names cannot steer the path", async () => {
    const res = await a.upload('../../../etc/passwd', 'text/plain', Buffer.from('x')).expect(201);
    expect(res.body.name).toBe('passwd');
    const stored = await readdir(join(process.env.FILE_STORAGE_DIR!, 'tenants', tenantA, 'files'));
    expect(stored).toEqual(expect.arrayContaining([fileOfA, res.body.id]));
    const roots = await readdir(join(process.env.FILE_STORAGE_DIR!, 'tenants'));
    expect(roots).not.toContain(tenantB); // B uploaded nothing
  });

  it('a file flagged by the malware scan is recorded as rejected and can never be downloaded', async () => {
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    const res = await a.upload('invoice.txt', 'text/plain', eicar).expect(201);
    expect(res.body.status).toBe('rejected');
    await a.post(`/v1/files/${res.body.id}/link`).expect(404);
  });

  it('disallowed file types are refused', async () => {
    await a.upload('run.sh', 'application/x-sh', Buffer.from('echo hi')).expect(400);
  });
});

describe('membership changes take effect immediately', () => {
  it('a removed member loses access on the very next request', async () => {
    const temp = await addMember(t, a, 'acme-temp', 'supervisor');
    await temp.get('/v1/members').expect(200);
    const id = (await a.get('/v1/members').expect(200)).body.find((m: { email: string }) => m.email === temp.email).id;
    await a.delete(`/v1/members/${id}`).expect(204);
    const res = await temp.get('/v1/members').expect(403);
    expect(res.body.error.message).toMatch(/no longer a member/);
    await temp.get(`/v1/files/${fileOfA}`).expect(403);
  });
});

describe('download links respect role changes (independent review finding)', () => {
  it('a link stops working when its holder loses the files.read permission', async () => {
    const worker = await addMember(t, a, 'acme-dl', 'agent');
    const link = (await worker.post(`/v1/files/${fileOfA}/link`).expect(201)).body.url;
    await worker.get(link).expect(200);
    const id = (await a.get('/v1/members').expect(200)).body.find((m: { email: string }) => m.email === worker.email).id;
    await a.put(`/v1/members/${id}/roles`, { roleKeys: ['analyst'] }).expect(204);
    await worker.get(link).expect(403);
  });
});
