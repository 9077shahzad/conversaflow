/**
 * Contact import from CSV (BRD v1.2 Wave 1, CF-EXT-003 / FR-302, migration 0038): preview, import, undo, consent
 * evidence, duplicates, opted-out customers, and company boundaries.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { normalisePhone, parseContactsCsv, readCsv } from '../src/modules/contacts-import';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let admin: Client;
let agent: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
/** A fresh UAE number for each use (country code 971). */
const fresh = () => `97150${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}`;
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
