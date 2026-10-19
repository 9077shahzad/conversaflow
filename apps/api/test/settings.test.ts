/** Company settings (FR-006), holidays, branches and teams — validation, permissions and isolation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let other: Client;

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'settings');
  await activateSubscription(t, await newCompany(owner, 'settings', 'business'));
  await enableMfa(owner);
  agent = await addMember(t, owner, 'settings-agent', 'agent');
  other = await newUser(t, 'settings-other');
  await newCompany(other, 'settings-other');
  await enableMfa(other);
});
afterAll(() => t?.close());

describe('company settings', () => {
  it('starts with defaults and saves hours, languages and SLA targets', async () => {
    expect((await owner.get('/v1/settings').expect(200)).body).toMatchObject({ languages: ['en'], holidays: [] });
    const saved = await owner.patch('/v1/settings', {
      businessHours: { sun: [['09:00', '17:00']], mon: [['09:00', '13:00'], ['14:00', '18:00']] },
      languages: ['ar', 'en'], slaFirstResponseMinutes: 15, slaResolutionMinutes: 1440,
    }).expect(200);
    expect(saved.body).toMatchObject({ languages: ['ar', 'en'], slaFirstResponseMinutes: 15, businessHours: { mon: [['09:00', '13:00'], ['14:00', '18:00']] } });
  });

  it('rejects impossible hours and unknown languages', async () => {
    await owner.patch('/v1/settings', { businessHours: { mon: [['18:00', '09:00']] } }).expect(400);
    await owner.patch('/v1/settings', { businessHours: { mon: [['25:00', '26:00']] } }).expect(400);
    await owner.patch('/v1/settings', { languages: ['fr'] }).expect(400);
  });

  it('records holidays once per day', async () => {
    await owner.post('/v1/settings/holidays', { day: '2026-12-02', name: 'UAE National Day' }).expect(201);
    await owner.post('/v1/settings/holidays', { day: '2026-12-02', name: 'Again' }).expect(409);
    expect((await owner.get('/v1/settings').expect(200)).body.holidays).toEqual([expect.objectContaining({ day: '2026-12-02' })]);
  });

  it('agents can read settings but not change them', async () => {
    await agent.get('/v1/settings').expect(200);
    await agent.patch('/v1/settings', { languages: ['en'] }).expect(403);
  });

  it("another company's settings and holidays are untouched and invisible", async () => {
    const theirs = (await other.get('/v1/settings').expect(200)).body;
    expect(theirs).toMatchObject({ languages: ['en'], holidays: [] });
    const holidayId = (await owner.get('/v1/settings').expect(200)).body.holidays[0].id;
    await other.delete(`/v1/settings/holidays/${holidayId}`).expect(404);
    expect((await owner.get('/v1/settings').expect(200)).body.holidays).toHaveLength(1);
  });
});

describe('branches and teams', () => {
  it('creates branches and teams and adds members', async () => {
    const branch = (await owner.post('/v1/branches', { name: 'Al Khobar', timezone: 'Asia/Riyadh' }).expect(201)).body;
    const team = (await owner.post('/v1/teams', { name: 'Maintenance desk', branchId: branch.id }).expect(201)).body;
    const agentId = (await owner.get('/v1/members').expect(200)).body.find((m: { email: string }) => m.email === agent.email).id;
    await owner.post(`/v1/teams/${team.id}/members`, { membershipId: agentId }).expect(204);
    expect((await owner.get('/v1/teams').expect(200)).body).toEqual([expect.objectContaining({ name: 'Maintenance desk', memberIds: [agentId] })]);
  });

  it("a team cannot use another company's branch, team or member (not found)", async () => {
    const theirBranch = (await other.post('/v1/branches', { name: 'Dubai' }).expect(201)).body;
    await owner.post('/v1/teams', { name: 'Cross', branchId: theirBranch.id }).expect(404);
    const myTeam = (await owner.get('/v1/teams').expect(200)).body[0];
    const theirMember = (await other.get('/v1/members').expect(200)).body[0].id;
    await owner.post(`/v1/teams/${myTeam.id}/members`, { membershipId: theirMember }).expect(404);
    await other.post(`/v1/teams/${myTeam.id}/members`, { membershipId: theirMember }).expect(404);
    expect((await owner.get('/v1/teams').expect(200)).body[0].memberIds).toHaveLength(1);
    expect((await other.get('/v1/teams').expect(200)).body).toEqual([]);
  });

  it('agents cannot create teams', async () => {
    await agent.post('/v1/teams', { name: 'Rogue' }).expect(403);
  });
});
