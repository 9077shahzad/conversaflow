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
import { TemplatesService } from '../modules/templates.service';
import { MediaFetcher } from '../modules/media';
import { CampaignRunner, CampaignsService } from '../modules/campaigns';
import { Sender } from '../modules/sender';
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
    languages: ['ar', 'en'], slaFirstResponseMinutes: 15, slaNextResponseMinutes: 60, slaResolutionMinutes: 480,
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

    // Templates: two approved (the review decision arrives as a sandbox webhook), one still in review.
    const templates = new TemplatesService(deps);
    // The simulated provider records the decision too, as WhatsApp would, then reports it by webhook.
    const review = (providerTemplateId: string, event: string) => {
      for (const list of sandbox.templates.values()) for (const x of list) if (x.providerTemplateId === providerTemplateId && event === 'APPROVED') x.status = 'approved';
      return reviewHook(providerTemplateId, event);
    };
    const reviewHook = (providerTemplateId: string, event: string) => inbox.ingest('sandbox', {
      object: 'whatsapp_business_account',
      entry: [{ id: `sbx-${number}`, time: now, changes: [{ field: 'message_template_status_update',
        value: { event, message_template_id: Number(providerTemplateId), message_template_name: 'demo', message_template_language: 'en', reason: null } }] }],
    });
    for (const [name, language, category, bodyText, examples, approve] of [
      ['visit_reminder', 'en', 'utility', 'Hello {{1}}, this is a reminder of your visit on {{2}}. Reply here if you need to change it.', ['Huda', 'Sunday 10:00'], true],
      ['visit_reminder_ar', 'ar', 'utility', 'مرحبًا {{1}}، نذكّرك بموعد الزيارة يوم {{2}}. يمكنك الرد هنا لتغيير الموعد.', ['هدى', 'الأحد 10:00'], true],
      ['spring_offer', 'en', 'marketing', 'Hi {{1}}, our spring AC service offer is open this week. Reply YES to book.', ['Huda'], false],
    ] as const) {
      const tpl = await templates.create(ownerActor, { name, language, category, bodyText, examples: [...examples] });
      if (approve) await review(tpl.providerTemplateId, 'APPROVED');
    }

    // A customer photo, downloaded and checked for malware like any inbound media.
    const photo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    sandbox.media.set('demo-photo-1', { data: photo, contentType: 'image/png' });
    await inbox.ingest('sandbox', {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: number },
        contacts: [{ wa_id: '966500000106', profile: { name: 'Layla (Demo)' } }],
        messages: [{ from: '966500000106', id: `wamid.demo.${suffix}.photo`, timestamp: String(now - 120), type: 'image',
          image: { id: 'demo-photo-1', mime_type: 'image/png', caption: 'Water under the kitchen sink' } }] } }] }],
    });
    await new MediaFetcher(deps.db, deps.channels, deps.storage, deps.scanner, config.MAX_UPLOAD_BYTES).dispatchDue();

    // Campaigns: two customers who agreed to offers, an approved marketing template, one sent campaign and one draft.
    for (const wa of ['966500000102', '966500000106']) {
      const conv = await convOf(wa);
      await inbox.setMarketingConsent(ownerActor, conv.contact.id, { granted: true, evidence: 'Asked for seasonal offers in chat (demo)' });
    }
    const offer = await templates.create(ownerActor, { name: 'autumn_offer', language: 'en', category: 'marketing',
      bodyText: 'Hi {{1}}, our autumn AC service offer is open this week. Reply YES to book.', examples: ['Emma'] });
    await review(offer.providerTemplateId, 'APPROVED');
    const campaigns = new CampaignsService(deps);
    const params = [{ source: 'contact_name', fallback: 'there' }];
    const sent = await campaigns.create(ownerActor, { name: 'Autumn AC offer (Demo)', templateId: offer.id, params });
    await campaigns.schedule(ownerActor, sent.id, { at: null });
    await new CampaignRunner(deps.db).runBatch(tenant.id, sent.id);
    await new Sender(deps.db, deps.channels).dispatchDue(50);
    await campaigns.create(ownerActor, { name: 'Ramadan reminder (Demo draft)', templateId: offer.id, params });
  }

  console.log(JSON.stringify({ ownerEmail, password: PASSWORD, tenantId: tenant.id }));
  await deps.db.end(); await deps.identityDb.end(); await deps.platformDb.end(); await notify.end(); deps.redis.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
