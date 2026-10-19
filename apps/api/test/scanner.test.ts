/**
 * Pre-pilot item 3: the test-only scanner is replaced by ClamAV (clamd). Uploads are fail-closed:
 * if the scanner cannot give a clear answer, the upload is refused and NOTHING is stored.
 */
import { readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDeps, createApp } from '../src/app';
import { loadConfig } from '../src/core/config';
import { ClamdScanner, parseClamdVersion } from '../src/core/storage';
import { Client, enableMfa, newCompany, newUser, startApp, type TestApp } from './helpers';

const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
// The local engine has only the test signature, so these engine tests switch the official-signature check off;
// the signature checks have their own tests below.
const clamd = () => new ClamdScanner(process.env.CLAMD_HOST!, Number(process.env.CLAMD_PORT), { timeoutMs: 5000, requireOfficialSignatures: false });

let t: TestApp;
let owner: Client;
let tenantId: string;
const storedFiles = async () => readdir(join(process.env.FILE_STORAGE_DIR!, 'tenants', tenantId, 'files')).catch(() => [] as string[]);

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'scan');
  tenantId = await newCompany(owner, 'scan');
  await enableMfa(owner);
});
afterAll(() => t?.close());

describe('ClamAV engine', () => {
  it('the API is configured with the real ClamAV scanner in this run', () => {
    expect(t.deps.config.SCANNER).toBe('clamd');
    expect(t.deps.scanner).toBeInstanceOf(ClamdScanner);
  });

  it('answers ping, passes clean data and detects the test virus, also inside a larger file', async () => {
    expect(await clamd().ping()).toBe(true);
    expect(await clamd().scan(Buffer.from('ordinary invoice text'))).toBe('clean');
    expect(await clamd().scan(EICAR)).toBe('infected');
    const big = Buffer.concat([Buffer.alloc(200_000, 0x41), EICAR, Buffer.alloc(200_000, 0x42)]);
    expect(await clamd().scan(big)).toBe('infected');
  });

  it('an infected upload is recorded as rejected and never written to storage', async () => {
    const before = await storedFiles();
    const res = await owner.upload('statement.txt', 'text/plain', EICAR).expect(201);
    expect(res.body.status).toBe('rejected');
    expect(await storedFiles()).toEqual(before);
    await owner.post(`/v1/files/${res.body.id}/link`).expect(404);
  });
});

describe('fail-closed when the scanner is unavailable', () => {
  async function appWithScanner(scanner: ClamdScanner) {
    const deps = buildDeps(loadConfig(process.env), { mailer: t.mailer, scanner });
    const app = await createApp(deps);
    return { app, close: async () => { await app.close(); await deps.db.end(); await deps.identityDb.end(); await deps.platformDb.end(); deps.redis.disconnect(); } };
  }

  it('scanner down: upload refused with 503, no file row, nothing on disk', async () => {
    const down = await appWithScanner(new ClamdScanner('127.0.0.1', 1, { timeoutMs: 1000 }));
    try {
      const c = new Client({ ...t, app: down.app }, owner.email);
      const cookie = owner.cookie!; // the same signed-in session, sent to the second app instance
      const rowsBefore = (await owner.get('/v1/files').expect(200)).body.length;
      const filesBefore = await storedFiles();
      const res = await c.agent.post('/v1/files').set('Cookie', cookie).set('X-Requested-With', 'conversaflow')
        .attach('file', Buffer.from('clean but unscanned'), { filename: 'a.txt', contentType: 'text/plain' }).expect(503);
      expect(res.body.error.code).toBe('scanner_unavailable');
      expect((await owner.get('/v1/files').expect(200)).body.length).toBe(rowsBefore);
      expect(await storedFiles()).toEqual(filesBefore);
    } finally {
      await down.close();
    }
  });

  it('scanner hangs: the scan times out and the upload is refused', async () => {
    const silent: Server = createServer(() => undefined); // accepts, never answers
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as { port: number }).port;
    try {
      await expect(new ClamdScanner('127.0.0.1', port, { timeoutMs: 500, requireOfficialSignatures: false }).scan(Buffer.from('x')))
        .rejects.toThrow(/unavailable: timeout/);
      // With the signature check on (production), a hanging scanner is refused even earlier: its state is unreadable.
      await expect(new ClamdScanner('127.0.0.1', port, { timeoutMs: 500 }).scan(Buffer.from('x'))).rejects.toThrow(/signatures unknown/);
    } finally {
      silent.close();
    }
  });

  it('production refuses to start with the test scanner', () => {
    expect(() => loadConfig({ ...process.env, NODE_ENV: 'production', SCANNER: 'signature' })).toThrow(/requires SCANNER=clamd/);
  });
});

/**
 * Minimal stand-in for clamd: answers VERSION with a chosen reply and INSTREAM with "stream: OK".
 * Lets the tests put the scanner in each signature state (current, outdated, missing, unreadable).
 */
async function fakeClamd(versionReply: () => string) {
  const server: Server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (buf.subarray(0, 9).toString() === 'zVERSION\0') {
        sock.end(`${versionReply()}\0`);
        return;
      }
      if (buf.subarray(0, 10).toString() === 'zINSTREAM\0') {
        let off = 10;
        while (off + 4 <= buf.length) {
          const len = buf.readUInt32BE(off);
          if (len === 0) { sock.end('stream: OK\0'); return; }
          off += 4 + len;
        }
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as { port: number }).port, close: () => server.close() };
}

const clamdDate = (hoursAgo: number) => {
  const d = new Date(Date.now() - hoursAgo * 3_600_000);
  const day = d.toUTCString().slice(0, 3);
  const mon = d.toUTCString().slice(8, 11);
  return `${day} ${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
};

describe('signature freshness: missing or outdated official signatures block uploads', () => {
  it('reads the four signature states from the clamd VERSION reply', () => {
    const now = new Date();
    expect(parseClamdVersion(`ClamAV 1.5.4/27800/${clamdDate(3)}`, now, 48)).toMatchObject({ state: 'current', databaseVersion: 27800 });
    expect(parseClamdVersion(`ClamAV 1.5.4/27700/${clamdDate(72)}`, now, 48)).toMatchObject({ state: 'outdated' });
    expect(parseClamdVersion('ClamAV 1.5.4', now, 48)).toMatchObject({ state: 'missing', engine: '1.5.4' });
    expect(parseClamdVersion('garbage', now, 48)).toMatchObject({ state: 'unknown' });
    expect(parseClamdVersion('ClamAV 1.5.4/27800/not a date', now, 48)).toMatchObject({ state: 'unknown' });
    // Independent recheck (N4): these must never count as current.
    const future = new Date(Date.now() + 5 * 24 * 3_600_000);
    const fmt = (d: Date) => `${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, ' ')} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
    expect(parseClamdVersion(`ClamAV 1.5.4/27800/${fmt(future)}`, now, 48)).toMatchObject({ state: 'unknown' });
    expect(parseClamdVersion('ClamAV 1.5.4/27800/Fri Jan  1 00:00:00 2099', now, 48)).toMatchObject({ state: 'unknown' });
    expect(parseClamdVersion(`ClamAV 1.5.4/0/${clamdDate(1)}`, now, 48)).toMatchObject({ state: 'unknown' });
    expect(parseClamdVersion('ClamAV 1.5.4/99999', now, 48)).toMatchObject({ state: 'unknown' });
    expect(parseClamdVersion('ClamAV 1.5.4/99999/', now, 48)).toMatchObject({ state: 'unknown' });
    expect(parseClamdVersion(`ClamAV 1.5.4/27800/${clamdDate(1)} +0300`, now, 48)).toMatchObject({ state: 'unknown' });
  });

  async function uploadWith(scanner: ClamdScanner, name: string) {
    const deps = buildDeps(loadConfig(process.env), { mailer: t.mailer, scanner });
    const app = await createApp(deps);
    try {
      const rowsBefore = (await owner.get('/v1/files').expect(200)).body.length;
      const filesBefore = await storedFiles();
      const res = await new Client({ ...t, app }, owner.email).agent.post('/v1/files').set('Cookie', owner.cookie!)
        .set('X-Requested-With', 'conversaflow')
        .attach('file', Buffer.from(`clean content ${name}`), { filename: `${name}.txt`, contentType: 'text/plain' });
      return {
        status: res.status, code: res.body?.error?.code as string | undefined,
        rowsAdded: (await owner.get('/v1/files').expect(200)).body.length - rowsBefore,
        filesAdded: (await storedFiles()).length - filesBefore.length,
      };
    } finally {
      await app.close(); await deps.db.end(); await deps.identityDb.end(); await deps.platformDb.end(); deps.redis.disconnect();
    }
  }

  for (const [label, reply, expected] of [
    ['official signatures missing (engine only)', () => 'ClamAV 1.5.4', 503],
    ['signatures older than the limit (72 h > 48 h)', () => `ClamAV 1.5.4/27700/${clamdDate(72)}`, 503],
    ['signature state unreadable', () => 'ClamAV ???', 503],
    ['current official signatures (3 h old)', () => `ClamAV 1.5.4/27800/${clamdDate(3)}`, 201],
  ] as const) {
    it(`${label} → ${expected === 201 ? 'upload accepted' : 'upload refused, nothing stored'}`, async () => {
      const fake = await fakeClamd(reply);
      try {
        const r = await uploadWith(new ClamdScanner('127.0.0.1', fake.port, { requireOfficialSignatures: true, maxSignatureAgeHours: 48 }), label.slice(0, 12).replace(/\W/g, ''));
        if (expected === 201) {
          expect(r).toEqual({ status: 201, code: undefined, rowsAdded: 1, filesAdded: 1 });
        } else {
          expect(r).toEqual({ status: 503, code: 'scanner_unavailable', rowsAdded: 0, filesAdded: 0 });
        }
      } finally {
        fake.close();
      }
    });
  }

  it('a refusal is not cached: once signatures are updated, uploads work again', async () => {
    let reply = 'ClamAV 1.5.4';
    const fake = await fakeClamd(() => reply);
    try {
      const scanner = new ClamdScanner('127.0.0.1', fake.port, { requireOfficialSignatures: true, maxSignatureAgeHours: 48 });
      await expect(scanner.scan(Buffer.from('x'))).rejects.toThrow(/signatures missing/);
      reply = `ClamAV 1.5.4/27801/${clamdDate(1)}`;
      expect(await scanner.scan(Buffer.from('x'))).toBe('clean');
    } finally {
      fake.close();
    }
  });

  it('the real local ClamAV, which has only the test signature, is refused when official signatures are required', async () => {
    const real = new ClamdScanner(process.env.CLAMD_HOST!, Number(process.env.CLAMD_PORT), { requireOfficialSignatures: true });
    expect((await real.signatureStatus(true)).state).toBe('missing');
    await expect(real.scan(Buffer.from('ordinary text'))).rejects.toThrow(/signatures missing/);
  });

  it('production refuses to start with the official-signature requirement switched off', () => {
    expect(() => loadConfig({ ...process.env, NODE_ENV: 'production', SCANNER: 'clamd', SCANNER_REQUIRE_OFFICIAL_SIGNATURES: 'false' }))
      .toThrow(/requires SCANNER_REQUIRE_OFFICIAL_SIGNATURES=true/);
    expect(loadConfig({ ...process.env, SCANNER_REQUIRE_OFFICIAL_SIGNATURES: undefined }).SCANNER_REQUIRE_OFFICIAL_SIGNATURES).toBe(true);
  });
});
