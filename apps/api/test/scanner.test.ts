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
import { ClamdScanner } from '../src/core/storage';
import { Client, enableMfa, newCompany, newUser, startApp, type TestApp } from './helpers';

const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const clamd = () => new ClamdScanner(process.env.CLAMD_HOST!, Number(process.env.CLAMD_PORT), 5000);

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
    const down = await appWithScanner(new ClamdScanner('127.0.0.1', 1, 1000));
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
      await expect(new ClamdScanner('127.0.0.1', port, 500).scan(Buffer.from('x'))).rejects.toThrow(/unavailable: timeout/);
    } finally {
      silent.close();
    }
  });

  it('production refuses to start with the test scanner', () => {
    expect(() => loadConfig({ ...process.env, NODE_ENV: 'production', SCANNER: 'signature' })).toThrow(/requires SCANNER=clamd/);
  });
});
