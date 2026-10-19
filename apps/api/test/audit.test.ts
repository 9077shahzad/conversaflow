/** Audit trail: recorded with every change, append-only, tamper-evident, and private to each company. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { addMember, asOwner, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let tenantId: string;

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'auditor');
  tenantId = await newCompany(owner, 'audited');
  await enableMfa(owner);
  await addMember(t, owner, 'aud-agent', 'agent');
  await owner.patch('/v1/tenant', { timezone: 'Asia/Riyadh' }).expect(200);
});
afterAll(() => t?.close());

describe('audit trail', () => {
  it('records each change in order with who did it', async () => {
    const events = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ seq: string; action: string; actorUserId: string }>;
    expect(events.map((e) => e.action).reverse()).toEqual(['tenant.created', 'member.invited', 'member.joined', 'tenant.updated']);
    expect(events.map((e) => Number(e.seq))).toEqual([4, 3, 2, 1]);
    expect(events[0]!.actorUserId).toBe(owner.userId);
  });

  it('the chain verifies as intact', async () => {
    expect((await owner.get('/v1/audit-events/verify').expect(200)).body).toEqual({ intact: true, firstBrokenSeq: null });
  });

  it('the application cannot edit or delete audit events', async () => {
    const ctx = { tenantId, userId: owner.userId! };
    await expect(withContext(t.deps.db, ctx, (tx) => tx.query("UPDATE audit_events SET action = 'x.y'"))).rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.deps.db, ctx, (tx) => tx.query('DELETE FROM audit_events'))).rejects.toMatchObject({ code: '42501' });
  });

  it('even the database owner is blocked by the append-only trigger', async () => {
    await expect(asOwner(t, tenantId, (tx) => tx.query("UPDATE audit_events SET action = 'x.y'"))).rejects.toThrow(/append-only/);
  });

  it('tampering by someone with direct database control is detected', async () => {
    await asOwner(t, tenantId, async (tx) => {
      await tx.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_change');
      await tx.query(`UPDATE audit_events SET metadata = '{"plan":"enterprise"}' WHERE seq = 1`);
      await tx.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_change');
    });
    expect((await owner.get('/v1/audit-events/verify').expect(200)).body).toEqual({ intact: false, firstBrokenSeq: 1 });
  });

  it("another company's audit trail is invisible", async () => {
    const other = await newUser(t, 'peer');
    await newCompany(other, 'peer');
    await enableMfa(other);
    const events = (await other.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(events.map((e) => e.action)).toEqual(['tenant.created']);
  });
});
