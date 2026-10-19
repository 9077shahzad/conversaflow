/** Structured request logs: correlation ids, and no secrets or content in logs. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDeps, createApp } from '../src/app';
import { loadConfig } from '../src/core/config';
import { Client, enableMfa, newCompany, newUser, PASSWORD, startApp, type TestApp } from './helpers';

let t: TestApp;
const lines: string[] = [];
let logged: Awaited<ReturnType<typeof createApp>>;
let owner: Client;

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'logs');
  await newCompany(owner, 'logs');
  await enableMfa(owner);
  logged = await createApp(buildDeps(loadConfig(process.env), { mailer: t.mailer, db: t.deps.db, identityDb: t.deps.identityDb, platformDb: t.deps.platformDb, redis: t.deps.redis }), { logSink: (l) => lines.push(l) });
});
afterAll(async () => { await logged?.close(); await t?.close(); });

describe('request logs', () => {
  it('every response carries a request id that matches its log line; a valid incoming id is kept', async () => {
    const res = await request(logged.getHttpServer()).get('/health').expect(200);
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.map((l) => JSON.parse(l)).find((l) => l.requestId === id)).toMatchObject({ method: 'GET', path: '/health', status: 200 });
    const mine = '11111111-2222-4333-8444-555555555555';
    expect((await request(logged.getHttpServer()).get('/health').set('X-Request-Id', mine)).headers['x-request-id']).toBe(mine);
    expect((await request(logged.getHttpServer()).get('/health').set('X-Request-Id', 'not a uuid; injected')).headers['x-request-id']).not.toContain('injected');
  });

  it('never logs passwords, emails, cookies, signed link tokens or file content', async () => {
    const http = request.agent(logged.getHttpServer());
    const login = await http.post('/v1/auth/login').set('X-Requested-With', 'conversaflow').send({ email: owner.email, password: PASSWORD });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const up = await request(logged.getHttpServer()).post('/v1/files').set('Cookie', owner.cookie!).set('X-Requested-With', 'conversaflow')
      .attach('file', Buffer.from('TOP-SECRET-CONTENT'), { filename: 'secret.txt', contentType: 'text/plain' });
    const link = (await request(logged.getHttpServer()).post(`/v1/files/${up.body.id}/link`).set('Cookie', owner.cookie!).set('X-Requested-With', 'conversaflow')).body.url as string;
    await request(logged.getHttpServer()).get(link).set('Cookie', owner.cookie!);
    const all = lines.join('\n');
    const token = link.split('token=')[1]!;
    for (const secret of [PASSWORD, owner.email, cookie.split('=')[1]!, token, 'TOP-SECRET-CONTENT', 'secret.txt']) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain('"path":"/v1/files/download"'); // the request is logged, without its query string
  });
});

describe('API security headers (review F3)', () => {
  it('every API response forbids running, framing and sniffing its content', async () => {
    const app = await startApp();
    try {
      for (const res of [await new Client(app, 'x').get('/v1/me'), await new Client(app, 'x').get('/health')]) {
        expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
      }
    } finally {
      await app.close();
    }
  });
});
