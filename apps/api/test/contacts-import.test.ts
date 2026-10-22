/**
 * Contact import from CSV (BRD v1.2 Wave 1, CF-EXT-003 / FR-302, migration 0038): preview, import, undo, consent
 * evidence, duplicates, opted-out customers, and company boundaries.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { ContactImportService, normalisePhone, parseContactsCsv, readCsv } from '../src/modules/contacts-import';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let admin: Client;
let agent: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
/** A fresh, valid UAE mobile number for each use (971 50 and seven digits). */
const base = Math.floor(Math.random() * 5_000_000);
const fresh = () => `97150${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
const contactByNumber = async (wa: string) => (await app((tx) => tx.query<{ id: string; name: string | null; locale: string | null; consent: Date | null; opted_out: Date | null; created_by_import: string | null }>(
  `SELECT c.id, c.display_name AS name, c.locale, c.marketing_consent_at AS consent, c.opted_out_at AS opted_out, c.created_by_import
   FROM contacts c JOIN contact_identifiers ci ON ci.contact_id = c.id WHERE ci.value = $1`, [wa]))).rows[0];
function inbound(from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Writer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const preview = (c: Client, csv: string, consentEvidence?: string) => c.post('/v1/contacts/imports', { fileName: 'customers.csv', csv, ...(consentEvidence ? { consentEvidence } : {}) });

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'imp-owner');
  tenant = await newCompany(owner, 'imp', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  admin = await addMember(t, owner, 'imp-admin', 'admin');
  agent = await addMember(t, owner, 'imp-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000044', label: 'Import' }).expect(201);
  otherOwner = await newUser(t, 'imp-other');
  await activateSubscription(t, await newCompany(otherOwner, 'impother', 'business'));
  await enableMfa(otherOwner);
});
afterAll(() => t?.close());

describe('reading the file', () => {
  it('reads quoted fields, commas and line breaks inside quotes, Windows line endings and a byte-order mark', () => {
    expect(readCsv('﻿phone,name\r\n"+971 50 111 2222","Al Noor, ""Main"" branch"\r\n971501113333,"Two\nlines"\n')).toEqual([
      ['phone', 'name'], ['+971 50 111 2222', 'Al Noor, "Main" branch'], ['971501113333', 'Two\nlines']]);
  });

  it('accepts international numbers in common forms and refuses local numbers instead of guessing the country', () => {
    expect(normalisePhone('+966 50 123 4567')).toEqual({ phone: '966501234567' });
    expect(normalisePhone('00971-50-123-4567')).toEqual({ phone: '971501234567' });
    expect(normalisePhone('(+966) 50.123.4567')).toEqual({ phone: '966501234567' });
    expect(normalisePhone('+٩٦٦٥٠١٢٣٤٥٦٧')).toEqual({ phone: '966501234567' });
    expect(normalisePhone('0501234567')).toEqual({ problem: 'local_number' });
    expect(normalisePhone('+12')).toEqual({ problem: 'invalid_phone' });
    expect(normalisePhone('call me')).toEqual({ problem: 'invalid_phone' });
  });

  it('classifies every row with a reason, finds repeats within the file, and understands Arabic headers and values', () => {
    const { rows, ignoredColumns } = parseContactsCsv([
      'الهاتف,الاسم,اللغة,موافقة تسويقية,city',
      '+966501110001,سارة,العربية,نعم,Riyadh',
      '966501110001,Repeat,,,',
      '0501110002,Local,,,',
      ',No number,,,',
      '+966501110003,Bad language,fr,,',
      '+966501110004,Bad consent,,maybe,',
    ].join('\n'));
    expect(ignoredColumns).toEqual(['city']);
    expect(rows.map((r) => [r.line, r.problem])).toEqual([
      [2, null], [3, 'duplicate_in_file'], [4, 'local_number'], [5, 'missing_phone'], [6, 'bad_language'], [7, 'bad_consent']]);
    expect(rows[0]).toMatchObject({ phone: '966501110001', name: 'سارة', language: 'ar', consent: true });
  });

  it('refuses a file without a number column, an empty file and an over-long file', () => {
    expect(() => parseContactsCsv('name\nSara')).toThrow(/WhatsApp number/);
    expect(() => parseContactsCsv('')).toThrow(/empty/);
    expect(() => parseContactsCsv(['phone', ...Array.from({ length: 5001 }, (_, i) => `+9665${String(i).padStart(8, '0')}`)].join('\n'))).toThrow(/5000/);
  });
});

describe('preview and import', () => {
  it('only owners and admins with two-step sign-in can import; agents cannot; other companies never see the batch', async () => {
    await preview(agent, 'phone\n+971501234000').expect(403);
    const res = await preview(admin, 'phone\n+971501234000');
    expect(res.body.error.code).toMatch(/mfa/);
    const p = (await preview(owner, `phone\n${fresh()}`).expect(201)).body;
    await otherOwner.post(`/v1/contacts/imports/${p.id}/commit`).expect(404);
    await otherOwner.post(`/v1/contacts/imports/${p.id}/undo`).expect(404);
  });

  it('the preview changes nothing and shows what would happen; the import applies exactly that, once', async () => {
    const a = fresh(); const b = fresh();
    const p = (await preview(owner, `phone,name,language\n+${a},Ahmed,en\n+${b},Bana,ar\n+${a},Again,\n050999,Local,\n`).expect(201)).body;
    expect(p.summary).toMatchObject({ rows: 4, new: 2, existing: 0, problemCount: 2, problems: { duplicate_in_file: 1, local_number: 1 }, needsEvidence: false });
    expect(p.problemRows).toEqual([{ line: 4, problem: 'duplicate_in_file' }, { line: 5, problem: 'local_number' }]);
    expect(await contactByNumber(a)).toBeUndefined();                    // nothing created by a preview
    const done = (await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200)).body;
    expect(done).toMatchObject({ status: 'imported', summary: { result: { created: 2, updated: 0, skipped: 2, consentGranted: 0 } } });
    expect(await contactByNumber(a)).toMatchObject({ name: 'Ahmed', locale: 'en', created_by_import: p.id, consent: null });
    expect(await contactByNumber(b)).toMatchObject({ name: 'Bana', locale: 'ar' });
    expect((await owner.post(`/v1/contacts/imports/${p.id}/commit`)).body.error.code).toBe('import_done');
    const listed = (await owner.get(`/v1/contacts?q=${a}`).expect(200)).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'Ahmed', whatsapp: a, importId: p.id });
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((x) => x.action)).toContain('contacts.imported');
  });

  it('existing contacts keep their name and language; only what is missing is filled in', async () => {
    const wa = fresh();
    await inbound(wa, 'Hello').expect(200);                              // creates the contact, named "Writer"
    const p = (await preview(owner, `phone,name,language\n+${wa},Different Name,ar\n`).expect(201)).body;
    expect(p.summary).toMatchObject({ new: 0, existing: 1 });
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    expect(await contactByNumber(wa)).toMatchObject({ name: 'Writer', locale: 'ar', created_by_import: null });
  });

  it('marketing consent needs the company\'s statement of how customers agreed, and is never recorded for someone who opted out', async () => {
    const yes = fresh(); const stopped = fresh();
    await inbound(stopped, 'STOP').expect(200);
    const csv = `phone,marketing_consent\n+${yes},yes\n+${stopped},yes\n`;
    const noEvidence = (await preview(owner, csv).expect(201)).body;
    expect(noEvidence.summary).toMatchObject({ consentToRecord: 1, consentRefusedOptedOut: 1, needsEvidence: true });
    expect((await owner.post(`/v1/contacts/imports/${noEvidence.id}/commit`)).body.error.code).toBe('consent_evidence_required');
    expect(await contactByNumber(yes)).toBeUndefined();
    await preview(owner, csv, 'short').expect(400);
    const p = (await preview(owner, csv, 'Signed the paper form at the Riyadh branch counter, Oct 2026').expect(201)).body;
    const done = (await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200)).body;
    expect(done.summary.result).toMatchObject({ created: 1, consentGranted: 1, consentRefusedOptedOut: 1 });
    expect((await contactByNumber(yes))!.consent).not.toBeNull();
    expect(await contactByNumber(stopped)).toMatchObject({ consent: null });
    const ev = (await app((tx) => tx.query<{ source: string; evidence: string }>(
      `SELECT e.source, e.evidence FROM consent_events e JOIN contact_identifiers ci ON ci.contact_id = e.contact_id WHERE ci.value = $1 AND e.kind = 'marketing_opt_in'`, [yes]))).rows;
    expect(ev).toEqual([{ source: 'import', evidence: expect.stringContaining('Signed the paper form') }]);
  });

  it('a "no" in a file never removes consent a customer already gave', async () => {
    const wa = fresh();
    await inbound(wa, 'Hello').expect(200);
    const id = (await contactByNumber(wa))!.id;
    await owner.post(`/v1/contacts/${id}/marketing-consent`, { granted: true, evidence: 'Asked for offers in chat' }).expect(200);
    const p = (await preview(owner, `phone,marketing_consent\n+${wa},no\n`).expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    expect((await contactByNumber(wa))!.consent).not.toBeNull();
  });

  it('rows are checked again at import time: a customer who opted out after the preview gets no consent', async () => {
    const wa = fresh();
    const p = (await preview(owner, `phone,marketing_consent\n+${wa},yes\n`, 'Ticked the offers box on our website form').expect(201)).body;
    expect(p.summary.consentToRecord).toBe(1);
    await inbound(wa, 'STOP').expect(200);                               // after the preview
    const done = (await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200)).body;
    expect(done.summary.result).toMatchObject({ created: 0, consentGranted: 0, consentRefusedOptedOut: 1 });
    expect(await contactByNumber(wa)).toMatchObject({ consent: null, created_by_import: null });
  });

  it('an import never sends anything', async () => {
    const before = (t.deps.channels.sandbox as unknown as { sent: unknown[] }).sent.length;
    const p = (await preview(owner, `phone,marketing_consent\n+${fresh()},yes\n`, 'Signed up for offers at the showroom').expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    expect((t.deps.channels.sandbox as unknown as { sent: unknown[] }).sent.length).toBe(before);
  });
});

describe('undo', () => {
  it('removes contacts the import created that have no conversation, keeps those who wrote in, and withdraws the consent it recorded', async () => {
    const quiet = fresh(); const wrote = fresh(); const existing = fresh();
    await inbound(existing, 'Hello').expect(200);
    const p = (await preview(owner, `phone,name,marketing_consent\n+${quiet},Quiet,yes\n+${wrote},Wrote,yes\n+${existing},Existing,yes\n`,
      'Opted in on the paper form at the branch').expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    await inbound(wrote, 'Thanks for adding me').expect(200);             // starts a conversation after the import
    const undone = (await owner.post(`/v1/contacts/imports/${p.id}/undo`).expect(200)).body;
    expect(undone).toMatchObject({ status: 'undone', summary: { undo: { removed: 1, kept: 1, consentWithdrawn: 2 } } });
    expect(await contactByNumber(quiet)).toBeUndefined();
    expect(await contactByNumber(wrote)).toMatchObject({ consent: null });
    expect(await contactByNumber(existing)).toMatchObject({ consent: null, name: 'Writer' });
    expect((await owner.post(`/v1/contacts/imports/${p.id}/undo`)).body.error.code).toBe('import_not_applied');
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((x) => x.action)).toContain('contacts.import_undone');
  });

  it('does not withdraw consent that was confirmed again after the import', async () => {
    const wa = fresh();
    const p = (await preview(owner, `phone,marketing_consent\n+${wa},yes\n`, 'Opted in on the paper form at the branch').expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    await inbound(wa, 'Hello').expect(200);
    const id = (await contactByNumber(wa))!.id;
    await owner.post(`/v1/contacts/${id}/marketing-consent`, { granted: true, evidence: 'Confirmed in chat that offers are welcome' }).expect(200);
    const undone = (await owner.post(`/v1/contacts/imports/${p.id}/undo`).expect(200)).body;
    expect(undone.summary.undo).toMatchObject({ removed: 0, kept: 1, consentWithdrawn: 0 });
    expect((await contactByNumber(wa))!.consent).not.toBeNull();
  });

  it('the database refuses to delete any other contact, even if the application asked', async () => {
    const wa = fresh();
    await inbound(wa, 'Hello').expect(200);
    const id = (await contactByNumber(wa))!.id;
    await expect(app((tx) => tx.query('DELETE FROM contacts WHERE id = $1', [id]))).rejects.toThrow(/only a contact created by an import/);
  });
});

describe('review of slice 5', () => {
  it('H1: a full 5,000-row file with names (well over 100 KB) can be previewed', async () => {
    const lines = ['phone,name,language'];
    for (let i = 0; i < 5000; i++) lines.push(`+97150${String(1000000 + i)},Customer number ${i} with a longer name,en`);
    const csv = lines.join('\n');
    expect(csv.length).toBeGreaterThan(200_000);
    const p = (await preview(owner, csv).expect(201)).body;
    expect(p.summary.rows).toBe(5000);
  });

  it('M1: an import and an incoming delivery touching the same numbers in opposite orders both complete', async () => {
    // Large enough that the import is still taking its per-number locks when the delivery arrives: the delivery holds
    // the last number first and then wants the first one, which the import already holds.
    const nums = Array.from({ length: 3000 }, () => fresh()).sort();
    const p = (await preview(owner, ['phone', ...nums.map((n) => `+${n}`)].join('\n')).expect(201)).body;
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
      contacts: [nums[2999]!, nums[0]!].map((wa) => ({ wa_id: wa, profile: { name: 'Writer' } })),
      messages: [nums[2999]!, nums[0]!].map((wa, i) => ({ from: wa, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000) + i), type: 'text', text: { body: 'Hi' } })) } }] }] });
    const hook = () => request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
    const committing = owner.post(`/v1/contacts/imports/${p.id}/commit`).then((r) => r);
    await new Promise((r) => setTimeout(r, 500));
    const [commit, delivery] = await Promise.all([committing, hook()]);
    expect([commit.status, delivery.status]).toEqual([200, 200]);
    for (const n of [nums[0]!, nums[2999]!]) {
      const count = (await app((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM contact_identifiers WHERE value = $1`, [n]))).rows[0]!.n;
      expect(count).toBe(1);                                              // one contact, whichever came first
    }
  });

  it('M2: an import "yes" does not override a customer\'s earlier marketing withdrawal', async () => {
    const wa = fresh();
    await inbound(wa, 'Hello').expect(200);
    const id = (await contactByNumber(wa))!.id;
    await owner.post(`/v1/contacts/${id}/marketing-consent`, { granted: true, evidence: 'Asked for offers in chat' }).expect(200);
    await owner.post(`/v1/contacts/${id}/marketing-consent`, { granted: false, evidence: 'Customer phoned: no more offers please' }).expect(200);
    const p = (await preview(owner, `phone,marketing_consent\n+${wa},yes\n`, 'Old paper form from 2023').expect(201)).body;
    expect(p.summary).toMatchObject({ consentToRecord: 0, consentRefusedWithdrawn: 1, needsEvidence: false });
    const done = (await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200)).body;
    expect(done.summary.result).toMatchObject({ consentGranted: 0, consentRefusedWithdrawn: 1 });
    expect((await contactByNumber(wa))!.consent).toBeNull();
  });

  it('M3: undo keeps a contact with its own consent history, so a withdrawal survives and a re-import cannot override it', async () => {
    const wa = fresh();
    const p = (await preview(owner, `phone,marketing_consent\n+${wa},yes\n`, 'Opted in on the paper form at the branch').expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    const id = (await contactByNumber(wa))!.id;
    await owner.post(`/v1/contacts/${id}/marketing-consent`, { granted: false, evidence: 'Customer asked us to stop offers' }).expect(200);
    const undone = (await owner.post(`/v1/contacts/imports/${p.id}/undo`).expect(200)).body;
    expect(undone.summary.undo).toMatchObject({ removed: 0, kept: 1, consentWithdrawn: 0 });
    const events = (await app((tx) => tx.query<{ kind: string }>('SELECT kind FROM consent_events WHERE contact_id = $1 ORDER BY created_at', [id]))).rows.map((r) => r.kind);
    expect(events).toEqual(['marketing_opt_in', 'marketing_opt_out']);
    const again = (await preview(owner, `phone,marketing_consent\n+${wa},yes\n`, 'Opted in on the paper form at the branch').expect(201)).body;
    expect(again.summary).toMatchObject({ consentToRecord: 0, consentRefusedWithdrawn: 1 });
    // The database refuses too, even if the application asked.
    await expect(app((tx) => tx.query('DELETE FROM contacts WHERE id = $1', [id]))).rejects.toThrow(/no other consent decision/);
  });

  it('M4: someone who cannot see every conversation only sees contacts whose conversation they could open', async () => {
    const hidden = fresh(); const open = fresh();
    await inbound(hidden, 'Hello').expect(200);
    await inbound(open, 'Hello').expect(200);
    const conv = (await app((tx) => tx.query<{ id: string; version: number }>(
      'SELECT c.id, c.version FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1', [hidden]))).rows[0]!;
    const adminId = (await admin.get('/v1/me/access').expect(200)).body.membershipId;
    await owner.post(`/v1/conversations/${conv.id}/assign`, { membershipId: adminId, expectedVersion: conv.version }).expect(200);
    expect((await agent.get(`/v1/contacts?q=${hidden}`).expect(200)).body).toEqual([]);
    expect((await agent.get(`/v1/contacts?q=${open}`).expect(200)).body).toHaveLength(1);
    expect((await owner.get(`/v1/contacts?q=${hidden}`).expect(200)).body).toHaveLength(1);
  });

  it('M5: numbers are checked against their country\'s numbering plan; a dropped leading 0 is refused, a "(0)" trunk digit is removed', () => {
    expect(normalisePhone('501234567')).toEqual({ problem: 'local_number' });
    expect(normalisePhone('+966 (0)50 123 4567')).toEqual({ phone: '966501234567' });
    expect(normalisePhone('+44 (0)20 7946 0958')).toEqual({ phone: '442079460958' });
    expect(normalisePhone('966501234567')).toEqual({ phone: '966501234567' });
    expect(normalisePhone('+999123456789')).toEqual({ problem: 'invalid_phone' });
  });

  it('L1: searching by name finds only matching contacts', async () => {
    const wa = fresh();
    const p = (await preview(owner, `phone,name\n+${wa},Zzunique Person\n`).expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    const found = (await owner.get('/v1/contacts?q=Zzunique').expect(200)).body as Array<{ name: string }>;
    expect(found.map((x) => x.name)).toEqual(['Zzunique Person']);
  });

  it('L2: no evidence is demanded when no consent would actually be recorded', async () => {
    const stopped = fresh();
    await inbound(stopped, 'STOP').expect(200);
    const p = (await preview(owner, `phone,marketing_consent\n+${stopped},yes\n`).expect(201)).body;
    expect(p.summary.needsEvidence).toBe(false);
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
  });

  it('L5: an unclosed quotation mark or two columns meaning the same thing are refused with a clear reason', async () => {
    expect((await preview(owner, 'phone,name\n+971501234567,"Never closed\n+971501234568,Next\n').expect(400)).body.error.code).toBe('unclosed_quote');
    expect((await preview(owner, 'mobile,phone\n,+971501234567\n').expect(400)).body.error.code).toBe('duplicate_columns');
  });
});

/** Runs `hold` in its own company transaction and keeps it open until `release` is called; rolls back afterwards. */
function holdOpen(hold: (tx: import('@conversaflow/database').Tx) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  const done = app(async (tx) => { await hold(tx); ready(); await gate; throw new Error('rollback'); }).catch(() => undefined);
  return { started, release: async () => { release(); await done; } };
}

describe('recheck of the slice 5 fixes', () => {
  it('N1: an import does not wait for, or deadlock with, another transaction that is adding records for the same contact', async () => {
    const wa = fresh();
    await inbound(wa, 'Hello').expect(200);
    const id = (await contactByNumber(wa))!.id;
    const p = (await preview(owner, `phone,name\n+${wa},Someone\n`).expect(201)).body;
    // A campaign batch or a consent record being written for this contact holds a key-share lock on it (foreign key).
    const other = holdOpen((tx) => tx.query(`INSERT INTO consent_events (tenant_id, contact_id, kind, channel, source, evidence)
                                             VALUES ($1, $2, 'opt_in', 'whatsapp', 'agent_recorded', 'held open by the test')`, [tenant, id]));
    await other.started;
    const result = await Promise.race([
      owner.post(`/v1/contacts/imports/${p.id}/commit`).then((r) => r.status),
      new Promise((r) => setTimeout(() => r('blocked'), 4000)),
    ]);
    await other.release();
    expect(result).toBe(200);
  });

  it('N2: a withdrawal recorded by undoing an import does not block importing the corrected file', async () => {
    const wa = fresh();
    await inbound(wa, 'Hello').expect(200);
    const p = (await preview(owner, `phone,marketing_consent\n+${wa},yes\n`, 'Signed the offers form at the branch').expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    expect((await owner.post(`/v1/contacts/imports/${p.id}/undo`).expect(200)).body.summary.undo).toMatchObject({ consentWithdrawn: 1 });
    const again = (await preview(owner, `phone,marketing_consent\n+${wa},yes\n`, 'Signed the offers form at the branch').expect(201)).body;
    expect(again.summary).toMatchObject({ consentToRecord: 1, consentRefusedWithdrawn: 0 });
    await owner.post(`/v1/contacts/imports/${again.id}/commit`).expect(200);
    expect((await contactByNumber(wa))!.consent).not.toBeNull();
  });

  it('N3: a decision whose wording imitates the import\'s own record still keeps the contact on undo', async () => {
    const wa = fresh();
    const p = (await preview(owner, `phone\n+${wa}\n`).expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    const id = (await contactByNumber(wa))!.id;
    await owner.post(`/v1/contacts/${id}/marketing-consent`, { granted: false, evidence: `Import ${p.id}: customer said no` }).expect(200);
    expect((await owner.post(`/v1/contacts/imports/${p.id}/undo`).expect(200)).body.summary.undo).toMatchObject({ removed: 0, kept: 1 });
    await expect(app((tx) => tx.query('DELETE FROM contacts WHERE id = $1', [id]))).rejects.toThrow(/no other consent decision/);
  });

  it('N4: undo takes the same per-number lock as an incoming message, so it waits instead of failing halfway', async () => {
    const wa = fresh();
    const p = (await preview(owner, `phone\n+${wa}\n`).expect(201)).body;
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(200);
    const other = holdOpen((tx) => tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenant}:wa:${wa}`]));
    await other.started;
    let finished = false;
    const undoing = owner.post(`/v1/contacts/imports/${p.id}/undo`).then((r) => { finished = true; return r; });
    await new Promise((r) => setTimeout(r, 700));
    expect(finished).toBe(false);
    await other.release();
    expect((await undoing).status).toBe(200);
  });

  it('L5: previews never imported are cleared after a day for every company, by the worker, without a new preview', async () => {
    const wa = fresh();
    const p = (await preview(owner, `phone,name\n+${wa},Kept Too Long\n`).expect(201)).body;
    // Make the preview look 25 hours old (owner role, with temporary policies inside one transaction).
    const c = await t.ownerDb.connect();
    try {
      await c.query('BEGIN');
      await c.query('CREATE POLICY test_age ON import_batches FOR UPDATE TO CURRENT_USER USING (true) WITH CHECK (true)');
      await c.query('CREATE POLICY test_age_read ON import_batches FOR SELECT TO CURRENT_USER USING (true)');
      expect((await c.query(`UPDATE import_batches SET created_at = now() - interval '25 hours' WHERE id = $1`, [p.id])).rowCount).toBe(1);
      await c.query('DROP POLICY test_age ON import_batches');
      await c.query('DROP POLICY test_age_read ON import_batches');
      await c.query('COMMIT');
    } finally { c.release(); }
    expect(await ContactImportService.expirePreviews(t.deps.db)).toBeGreaterThanOrEqual(1);
    const left = (await app((tx) => tx.query<{ rows: unknown[]; file_name: string }>('SELECT rows, file_name FROM import_batches WHERE id = $1', [p.id]))).rows[0]!;
    expect(left).toEqual({ rows: [], file_name: 'customers.csv' });
    await owner.post(`/v1/contacts/imports/${p.id}/commit`).expect(409);
  });
});
