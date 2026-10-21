/**
 * Media messages (Wave 1). Inbound media is downloaded in the background, checked for malware and stored in the
 * company's own folder; nothing is shown to staff until it is clean. Outbound media uses a stored, clean file of the
 * same company, of a type and size WhatsApp accepts, checked again at send time.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { MediaFetcher } from '../src/modules/media';
import { Sender } from '../src/modules/sender';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);

let t: TestApp;
let owner: Client;
let agent: Client;
let otherOwner: Client;
let sandbox: SandboxAdapter;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9733${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;

function deliver(value: Record<string, unknown>) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
    value: { metadata: { phone_number_id: NUMBER }, ...value } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const textIn = (from: string, text: string) => ({
  contacts: [{ wa_id: from, profile: { name: 'Customer' } }],
  messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});
function mediaIn(from: string, type: string, part: Record<string, unknown>, id = `wamid.in.${randomUUID()}`) {
  return { contacts: [{ wa_id: from, profile: { name: 'Customer' } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type, [type]: part }] };
}
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
async function newConversation() {
  const wa = nextWaId();
  await deliver(textIn(wa, 'Hello')).expect(200);
  const items = (await agent.get('/v1/conversations?limit=100').expect(200)).body.items as Array<{ id: string }>;
  for (const it of items) {
    const conv = (await agent.get(`/v1/conversations/${it.id}`).expect(200)).body;
    if (conv.contact.whatsapp === wa) return { ...conv, wa };
  }
  throw new Error('conversation not found');
}
const getConv = async (id: string) => (await agent.get(`/v1/conversations/${id}`).expect(200)).body;
const fetcher = (scanner = t.deps.scanner) => new MediaFetcher(t.deps.db, t.deps.channels, t.deps.storage, scanner, t.deps.config.MAX_UPLOAD_BYTES);
const lastMedia = async (convId: string) => (await getConv(convId)).messages.filter((m: { kind: string }) => m.kind === 'media').at(-1);
const mediaJob = async (messageId: string) => (await app((tx) => tx.query<{ state: string; attempts: number; last_error: string | null }>(
  'SELECT state, attempts, last_error FROM media_jobs WHERE message_id = $1', [messageId]))).rows[0];
const dueNow = () => app((tx) => tx.query(`UPDATE media_jobs SET next_attempt_at = now() WHERE state = 'pending'`));

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'media-owner');
  tenant = await newCompany(owner, 'media', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'media-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+973300000000', label: 'BH' }).expect(201);
  otherOwner = await newUser(t, 'media-other');
  const other = await newCompany(otherOwner, 'mediaother', 'business');
  await activateSubscription(t, other);
});
afterAll(() => t?.close());

describe('inbound media', () => {
  it('a photo is recorded at once, then downloaded, scanned clean and stored in the company\'s folder', async () => {
    const conv = await newConversation();
    const mediaId = `media-${randomUUID()}`;
    sandbox.media.set(mediaId, { data: PNG, contentType: 'image/png' });
    const id = `wamid.in.${randomUUID()}`;
    await deliver(mediaIn(conv.wa, 'image', { id: mediaId, mime_type: 'image/png', caption: 'The leak under the sink' }, id)).expect(200);
    await deliver(mediaIn(conv.wa, 'image', { id: mediaId, mime_type: 'image/png', caption: 'The leak under the sink' }, id)).expect(200); // repeat
    let m = await lastMedia(conv.id);
    expect(m).toMatchObject({ kind: 'media', mediaType: 'image', mediaStatus: 'pending', fileId: null, body: 'The leak under the sink' });
    expect(await fetcher().dispatchDue()).toBe(1); // one job, not two
    m = await lastMedia(conv.id);
    expect(m).toMatchObject({ mediaStatus: 'available' });
    const file = (await agent.get(`/v1/files/${m.fileId}`).expect(200)).body;
    expect(file).toMatchObject({ status: 'available', contentType: 'image/png' });
    expect(Number(file.sizeBytes)).toBe(PNG.length);
    const key = (await app((tx) => tx.query<{ storage_key: string; source: string }>('SELECT storage_key, source FROM files WHERE id = $1', [m.fileId]))).rows[0]!;
    expect(key.storage_key.startsWith(`tenants/${tenant}/files/`)).toBe(true);
    expect(key.source).toBe('whatsapp_inbound');
    expect((await t.deps.storage.get(key.storage_key)).equals(PNG)).toBe(true);
    // Another company cannot reach it.
    await otherOwner.get(`/v1/files/${m.fileId}`).expect(404);
  });

  it('an infected document is kept out: marked rejected, never stored, never linked to the message', async () => {
    const conv = await newConversation();
    const mediaId = `media-${randomUUID()}`;
    sandbox.media.set(mediaId, { data: EICAR, contentType: 'application/pdf' });
    await deliver(mediaIn(conv.wa, 'document', { id: mediaId, mime_type: 'application/pdf', filename: 'invoice.pdf' })).expect(200);
    await fetcher().dispatchDue();
    const m = await lastMedia(conv.id);
    expect(m).toMatchObject({ mediaStatus: 'rejected', fileId: null, mediaFilename: 'invoice.pdf' });
    const rows = (await app((tx) => tx.query<{ status: string; storage_key: string }>(
      `SELECT status, storage_key FROM files WHERE source = 'whatsapp_inbound' AND original_name = 'invoice.pdf'`))).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('rejected');
    await expect(t.deps.storage.get(rows[0]!.storage_key)).rejects.toThrow();
  });

  it('types we do not accept and files above the limit are recorded but not downloaded or stored', async () => {
    const conv = await newConversation();
    await deliver(mediaIn(conv.wa, 'image', { id: `media-${randomUUID()}`, mime_type: 'image/gif' })).expect(200);
    const gif = await lastMedia(conv.id);
    expect(gif.mediaStatus).toBe('unsupported');
    expect(await mediaJob(gif.id)).toBeUndefined();
    const big = `media-${randomUUID()}`;
    sandbox.media.set(big, { data: Buffer.alloc(5 * 1024 * 1024 + 1, 7), contentType: 'image/jpeg' });
    await deliver(mediaIn(conv.wa, 'image', { id: big, mime_type: 'image/jpeg' })).expect(200);
    await fetcher().dispatchDue();
    expect((await lastMedia(conv.id)).mediaStatus).toBe('too_large');
    // The provider says image/jpeg but delivers something else: the delivered type decides.
    const odd = `media-${randomUUID()}`;
    sandbox.media.set(odd, { data: PNG, contentType: 'application/x-msdownload' });
    await deliver(mediaIn(conv.wa, 'image', { id: odd, mime_type: 'image/jpeg' })).expect(200);
    await fetcher().dispatchDue();
    expect((await lastMedia(conv.id)).mediaStatus).toBe('unsupported');
  });

  it('expired media is marked failed; a temporary problem is retried with back-off, then gives up after the limit', async () => {
    const conv = await newConversation();
    await deliver(mediaIn(conv.wa, 'audio', { id: 'media-expired', mime_type: 'audio/ogg; codecs=opus' })).expect(200);
    await fetcher().dispatchDue();
    expect((await lastMedia(conv.id)).mediaStatus).toBe('failed');

    const later = `media-${randomUUID()}`;
    sandbox.media.set(later, { data: Buffer.from('OggS voice note'), contentType: 'audio/ogg' });
    await deliver(mediaIn(conv.wa, 'audio', { id: later, mime_type: 'audio/ogg' })).expect(200);
    sandbox.mediaScript.push({ notAccepted: 'busy' });
    await fetcher().dispatchDue();
    let m = await lastMedia(conv.id);
    expect(m.mediaStatus).toBe('pending');
    expect(await mediaJob(m.id)).toMatchObject({ state: 'pending', attempts: 1, last_error: 'busy' });
    expect(await fetcher().dispatchDue()).toBe(0); // not due yet
    await dueNow();
    await fetcher().dispatchDue();
    expect((await lastMedia(conv.id)).mediaStatus).toBe('available');

    const never = `media-${randomUUID()}`;
    sandbox.media.set(never, { data: Buffer.from('x'), contentType: 'audio/ogg' });
    await deliver(mediaIn(conv.wa, 'audio', { id: never, mime_type: 'audio/ogg' })).expect(200);
    sandbox.mediaScript.push(...Array.from({ length: 5 }, () => ({ notAccepted: 'busy' })));
    for (let i = 0; i < 6; i++) { await dueNow(); await fetcher().dispatchDue(); }
    m = await lastMedia(conv.id);
    expect(m.mediaStatus).toBe('failed');
    expect(await mediaJob(m.id)).toMatchObject({ state: 'dead', last_error: 'retries_exhausted:busy' });
  });

  it('no clear answer from the malware scanner means "try later", never "accept"', async () => {
    const conv = await newConversation();
    const id = `media-${randomUUID()}`;
    sandbox.media.set(id, { data: PNG, contentType: 'image/png' });
    await deliver(mediaIn(conv.wa, 'image', { id, mime_type: 'image/png' })).expect(200);
    await fetcher({ scan: async () => { throw new Error('clamd down'); } }).dispatchDue();
    const m = await lastMedia(conv.id);
    expect(m).toMatchObject({ mediaStatus: 'pending', fileId: null });
    expect(await mediaJob(m.id)).toMatchObject({ state: 'pending', last_error: 'scanner_unavailable' });
  });
});

describe('outbound media', () => {
  it('a clean company file is sent as a media message with its caption', async () => {
    const conv = await newConversation();
    const up = (await agent.upload('quote-1042.pdf', 'application/pdf', Buffer.from('%PDF-1.4 quote'))).body;
    expect(up.status).toBe('available');
    const before = sandbox.sent.length;
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Your quote', fileId: up.id, seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(res.body.status).toBe('sent');
    expect(sandbox.sent.length).toBe(before + 1);
    expect(sandbox.sent.at(-1)!.body).toContain('[document quote-1042.pdf');
    expect(sandbox.sent.at(-1)!.body).toContain('Your quote');
    const m = (await getConv(conv.id)).messages.find((x: { id: string }) => x.id === res.body.id);
    expect(m).toMatchObject({ kind: 'media', mediaType: 'document', fileId: up.id });
  });

  it('refuses another company\'s file, an infected file, and a type WhatsApp does not accept', async () => {
    const conv = await newConversation();
    await enableMfa(otherOwner);
    const foreign = (await otherOwner.upload('theirs.pdf', 'application/pdf', Buffer.from('%PDF-1.4 other'))).body;
    const send = async (fileId: string) => agent.post(`/v1/conversations/${conv.id}/reply`,
      { fileId, seenActivity: (await getConv(conv.id)).activitySeq, clientMessageId: randomUUID() });
    expect((await send(foreign.id)).status).toBe(404);
    const bad = (await agent.upload('bad.pdf', 'application/pdf', EICAR)).body;
    expect(bad.status).toBe('rejected');
    expect((await send(bad.id)).status).toBe(404);
    const csv = (await agent.upload('list.csv', 'text/csv', Buffer.from('a,b'))).body;
    expect((await send(csv.id)).status).toBe(400);
    await agent.post(`/v1/conversations/${conv.id}/reply`, { text: '', seenActivity: (await getConv(conv.id)).activitySeq, clientMessageId: randomUUID() }).expect(400);
  });

  it('a file that is no longer available when the message is sent blocks it; nothing is sent', async () => {
    const conv = await newConversation();
    const up = (await agent.upload('plan.pdf', 'application/pdf', Buffer.from('%PDF-1.4 plan'))).body;
    const membership = (await agent.get('/v1/me/access').expect(200)).body.membershipId as string;
    const msgId = await app(async (tx) => {
      const m = (await tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status,
                               media_type, media_status, file_id, media_mime)
         VALUES ($1, $2, 'out', 'media', NULL, $3, $4, clock_timestamp(), 'queued', 'document', 'available', $5, 'application/pdf') RETURNING id`,
        [tenant, conv.id, randomUUID(), membership, up.id])).rows[0]!;
      await tx.query('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2)', [tenant, m.id]);
      await tx.query(`UPDATE files SET status = 'rejected' WHERE id = $1`, [up.id]);
      return m.id;
    });
    const before = sandbox.sent.length;
    await new Sender(t.deps.db, t.deps.channels, {}, undefined, t.deps.storage).dispatchDue();
    expect(sandbox.sent.length).toBe(before);
    expect((await getConv(conv.id)).messages.find((x: { id: string }) => x.id === msgId)).toMatchObject({ status: 'failed', failureKind: 'blocked', errorCode: 'file_unavailable' });
  });
});
