/**
 * Seeds a SYNTHETIC demo company for local UI checks and screenshots. Never run against production.
 * Prints the demo sign-in details as JSON. Uses the same services and database roles as the real API.
 */
import { createPool } from '@conversaflow/database';
import { buildDeps } from '../app';
import { loadConfig } from '../core/config';
import { MemoryMailer } from '../core/mailer';
import { AuthService } from '../modules/auth.service';
import { MembersService } from '../modules/members.service';
import { loadActor } from '../modules/rbac';
import { SettingsService } from '../modules/settings.service';
import { TenantsService } from '../modules/tenants.service';
import { InboxService } from '../modules/inbox.service';
import type { SandboxAdapter } from '../modules/channels';
import { Notifier } from '../worker/notifier';

const PASSWORD = 'Demo-Only-Password-2026';

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production.');
  const mailer = new MemoryMailer();
  const deps = buildDeps(config, { mailer });
  const notify = createPool(process.env.DATABASE_NOTIFY_URL!, 1);
  const notifier = new Notifier(notify, mailer, config.APP_ORIGIN);
  const auth = new AuthService(deps);
  const client = { ip: '127.0.0.1' };
  const tokenFor = async (email: string) => {
    await notifier.processPending();
    return /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)!.text)![1]!;
  };
  const person = async (email: string, fullName: string, locale: 'en' | 'ar') => {
    await deps.redis.flushdb();
    await auth.signup({ email, password: PASSWORD, fullName, locale }, client);
    await auth.verifyEmail(await tokenFor(email));
    const { token } = await auth.login({ email, password: PASSWORD }, client);
    return (await auth.authenticate(token))!;
  };

  const suffix = Date.now().toString(36);
  const ownerEmail = `owner.${suffix}@demo.example`;
  const owner = await person(ownerEmail, 'Fatima Al-Harbi', 'ar');
  const tenant = await new TenantsService(deps).create(owner, {
    legalName: 'Al Noor Facilities (Demo)', slug: `al-noor-${suffix}`, country: 'SA', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'ar', planCode: 'growth',
  });
  const actor = (await loadActor(deps.db, tenant.id, owner.userId))!;
  await new SettingsService(deps).updateSettings(actor, {
    businessHours: { sun: [['08:00', '17:00']], mon: [['08:00', '17:00']], tue: [['08:00', '17:00']], wed: [['08:00', '17:00']], thu: [['08:00', '13:00']] },
    languages: ['ar', 'en'], slaFirstResponseMinutes: 15, slaResolutionMinutes: 480,
  });
  await new SettingsService(deps).addHoliday(actor, { day: '2026-12-02', name: 'UAE National Day / اليوم الوطني' });
  // Invitations need an Owner with MFA in the API; the seed acts at service level with the same checks on seats.
  const members = new MembersService(deps);
  for (const [email, name, role] of [
    [`agent.${suffix}@demo.example`, 'Omar Siddiqui', 'agent'],
    [`supervisor.${suffix}@demo.example`, 'Sarah Khan', 'supervisor'],
  ] as const) {
    const p = await person(email, name, 'en');
    await members.invite(actor, { email, roleKey: role });
    const tok = /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)!.text)![1]!;
    await members.accept(p, { token: tok });
  }

  // Synthetic inbox (sandbox channel only; nothing leaves the machine). Every name and number below is invented.
  const inbox = new InboxService(deps);
  const sandbox = deps.channels.sandbox as SandboxAdapter | undefined;
  if (sandbox) {
    const number = `demo${suffix}`;
    const ownerActor = (await loadActor(deps.db, tenant.id, owner.userId))!;
    await inbox.connectChannel(ownerActor, { provider: 'sandbox', providerNumberId: number, displayPhone: '+966 50 000 0000', label: 'Demo channel (sandbox)' });
    const now = Math.floor(Date.now() / 1000);
    let n = 0;
    const say = (from: string, name: string, text: string, ago: number) => inbox.ingest('sandbox', {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: number },
        contacts: [{ wa_id: from, profile: { name } }],
        messages: [{ from, id: `wamid.demo.${suffix}.${++n}`, timestamp: String(now - ago), type: 'text', text: { body: text } }] } }] }],
    });
    const convOf = async (wa: string) => {
      const list = await inbox.list(ownerActor, { limit: 50 });
      for (const it of list.items) { const c = await inbox.get(ownerActor, it.id); if (c.contact.whatsapp === wa) return c; }
      throw new Error('demo conversation missing');
    };
    await say('966500000101', 'Khalid (Demo)', 'السلام عليكم، هل تقدمون صيانة للمكيفات في الدمام؟', 900);
    await say('966500000102', 'Emma (Demo)', 'Hi, can you send a technician for a leaking tap tomorrow morning?', 1800);
    let c = await convOf('966500000102');
    await inbox.reply(ownerActor, c.id, { text: 'Yes — we have a slot between 9 and 11. Shall I book it?', seenActivity: c.activitySeq, clientMessageId: crypto.randomUUID() });
    sandbox.script.push({ reject: '131026' });
    c = await convOf('966500000102');
    await inbox.reply(ownerActor, c.id, { text: 'Please confirm the building number.', seenActivity: c.activitySeq, clientMessageId: crypto.randomUUID() });
    await say('966500000103', 'Noura (Demo)', 'The technician did not arrive and nobody answered the phone.', 600);
    c = await convOf('966500000103');
    await inbox.pause(ownerActor, c.id, { reason: 'Complaint — I am calling the customer myself', minutes: 120 });
    await say('966500000104', 'Faisal (Demo)', 'STOP 🛑', 300);
    await say('966500000105', 'Huda (Demo)', 'Do you clean water tanks?', 26 * 3600);
  }

  console.log(JSON.stringify({ ownerEmail, password: PASSWORD, tenantId: tenant.id }));
  await deps.db.end(); await deps.identityDb.end(); await deps.platformDb.end(); await notify.end(); deps.redis.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
