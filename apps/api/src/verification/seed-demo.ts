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
import { SavedRepliesService, TagsService } from '../modules/inbox-tools';
import { CampaignRunner, CampaignsService } from '../modules/campaigns';
import { Sender } from '../modules/sender';
import { Notifier } from '../worker/notifier';
import { CreditsService, createPaymentProvider } from '../modules/credits';

const PASSWORD = 'Demo-Only-Password-2026';

async function main() {
  // Demo data is applied as it is recorded, so the seed can build on it straight away (review of AX-3, L5).
  const config = loadConfig({ ...process.env, INBOUND_APPLY: 'request' });
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

    // Two customers who came from an invented Click-to-WhatsApp ad (simulated referral data, for the ad report).
    for (const [wa, name, text, ago] of [['966500000111', 'Saeed (Demo)', 'I saw your ad about AC servicing. Do you cover Khobar?', 1200],
      ['966500000112', 'Maha (Demo)', 'شفت إعلانكم، كم سعر تنظيف المكيف؟', 700]] as const) {
      await inbox.ingest('sandbox', { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: number },
        contacts: [{ wa_id: wa, profile: { name } }],
        messages: [{ from: wa, id: `wamid.demo.${suffix}.ad.${wa}`, timestamp: String(now - ago), type: 'text', text: { body: text },
          referral: { source_type: 'ad', source_id: '120000000000001', source_url: 'https://fb.me/demo-ad', headline: 'Summer AC service (demo ad)', ctwa_clid: `demo-clid-${wa}` } }] } }] }] });
    }

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

    // Tags and saved replies; one conversation tagged. Automatic assignment stays off (the company's choice).
    const tagsSvc = new TagsService(deps);
    const vip = await tagsSvc.create(ownerActor, { name: 'VIP', color: 'amber' });
    await tagsSvc.create(ownerActor, { name: 'شكوى / Complaint', color: 'red' });
    await tagsSvc.create(ownerActor, { name: 'Riyadh', color: 'teal' });
    await tagsSvc.tagConversation(ownerActor, (await convOf('966500000102')).id, vip.id, true);
    const replies = new SavedRepliesService(deps);
    await replies.create(ownerActor, { title: 'Opening hours', body: 'Hi {name}, we are open Sunday to Wednesday 8:00–17:00 and Thursday 8:00–13:00.', language: 'en' });
    await replies.create(ownerActor, { title: 'مواعيد العمل', body: 'مرحبًا {name}، نعمل من الأحد إلى الأربعاء من 8:00 إلى 17:00، والخميس من 8:00 إلى 13:00.', language: 'ar' });
  }

  // Prepaid message credits (test mode): an account opened as platform staff would, demo rates (not Meta's prices), and
  // one simulated top-up with its receipt. Only when the local owner connection is available.
  if (process.env.DATABASE_URL) {
    const ownerPool = createPool(process.env.DATABASE_URL, 1);
    const c = await ownerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE cf_ops');
      await c.query(`INSERT INTO messaging_routes (tenant_id, route, note) VALUES ($1, 'partner_360dialog', 'Demo company on the partner route (test mode)')`, [tenant.id]);
      await c.query(`INSERT INTO credit_accounts (tenant_id, currency, low_threshold_minor) VALUES ($1, 'SAR', 5000)`, [tenant.id]);
      // Always a fresh, complete demo card: the newest card in force is the one used.
      {
        const card = (await c.query<{ id: string }>(`INSERT INTO credit_rate_cards (currency, effective_from, source) VALUES ('SAR', now(), 'Demo rates (not Meta prices)') RETURNING id`)).rows[0]!.id;
        await c.query(`INSERT INTO credit_rate_lines (card_id, market, category, unit_cost_minor) VALUES
          ($1, 'saudi_arabia', 'marketing', 17), ($1, 'saudi_arabia', 'utility', 4), ($1, 'saudi_arabia', 'authentication', 4),
          ($1, 'other', 'marketing', 25), ($1, 'other', 'utility', 6), ($1, 'other', 'authentication', 6)`, [card]);
        await c.query(`INSERT INTO credit_rate_markets (card_id, prefix, market) VALUES ($1, '966', 'saudi_arabia')`, [card]);
      }
      await c.query('COMMIT');
    } finally { c.release(); await ownerPool.end(); }
    const credits = new CreditsService(deps, createPaymentProvider('test', deps.keys.webhookSecrets, config.APP_ORIGIN));
    const top = await credits.startTopUp(actor, { amountMinor: 20000 });
    await credits.simulateCheckout(actor, top.id, 'succeeded');
  }

  // SAMPLE history for the dashboards (owner request of 30 Oct 2026): four weeks of invented traffic on two sandbox
  // numbers, customers in several countries, replies by the demo team with mixed delivery results, and a few charged
  // messages. Inbound messages go through the real service and are then dated back; the dashboards label all of it as
  // test data because every number is a sandbox number.
  let staff: { staffEmail: string; staffTotpSecret: string } | null = null;
  if (process.env.DATABASE_URL && sandbox) {
    const ownerActor = (await loadActor(deps.db, tenant.id, owner.userId))!;
    const branch = `branch${suffix}`;
    await inbox.connectChannel(ownerActor, { provider: 'sandbox', providerNumberId: branch, displayPhone: '+966 50 000 0001', label: 'Riyadh branch (sandbox)' });
    const main = `demo${suffix}`;
    const ownerPool = createPool(process.env.DATABASE_URL, 1);
    const c = await ownerPool.connect();
    try {
      const prefixes = ['9665', '9665', '9665', '9715', '9715', '2010', '9230', '9198', '4477', '9656'];
      let k = 0;
      const plan: Array<{ wa: string; number: string; daysAgo: number }> = [];
      for (let day = 27; day >= 1; day--) {
        const count = 3 + ((day * 7) % 5);
        for (let i = 0; i < count; i++) {
          k++;
          const wa = `${prefixes[k % prefixes.length]}${String(1000000 + k * 37).slice(-8)}`;
          plan.push({ wa, number: k % 3 === 0 ? branch : main, daysAgo: day });
        }
      }
      for (const p of plan) {
        await inbox.ingest('sandbox', { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: p.number },
          contacts: [{ wa_id: p.wa, profile: { name: 'Sample customer' } }],
          messages: [{ from: p.wa, id: `wamid.sample.${suffix}.${p.wa}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Sample message' } }] } }] }] });
      }
      const ms = (await c.query<{ id: string; email: string }>(`SELECT m.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1`, [tenant.id])).rows;
      const team = ms.map((m) => m.id);
      await c.query('BEGIN');
      for (const t of ['messages', 'conversations', 'conversation_events', 'contact_identifiers', 'contacts']) await c.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      let j = 0;
      const charges: Array<{ messageId: string; at: string; category: 'service' | 'utility' | 'marketing' }> = [];
      for (const p of plan) {
        j++;
        const conv = (await c.query<{ id: string }>(
          `SELECT cv.id FROM conversations cv JOIN contact_identifiers ci ON ci.contact_id = cv.contact_id AND ci.tenant_id = cv.tenant_id
           WHERE cv.tenant_id = $1 AND ci.value = $2 ORDER BY cv.created_at DESC LIMIT 1`, [tenant.id, p.wa])).rows[0];
        if (!conv) continue;
        const at = `now() - make_interval(days => ${p.daysAgo}, hours => ${(j * 5) % 9}, mins => ${(j * 13) % 50})`;
        await c.query(`UPDATE messages SET created_at = ${at}, occurred_at = ${at} WHERE conversation_id = $1`, [conv.id]);
        await c.query(`UPDATE conversations SET created_at = ${at}, first_inbound_at = ${at}, last_inbound_at = ${at}, last_message_at = ${at} WHERE id = $1`, [conv.id]);
        await c.query(`UPDATE contacts SET created_at = ${at} WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [conv.id]);
        if (j % 6 === 0) continue;                                         // some conversations are not answered
        const who = team[j % team.length]!;
        const status = j % 17 === 0 ? 'failed' : j % 3 === 0 ? 'delivered' : 'read';
        const reply = `${at} + make_interval(mins => ${[2, 4, 9, 22, 48, 95, 260][j % 7]})`;
        const out = (await c.query<{ id: string }>(`INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, failure_kind,
                         provider_message_id, created_at)
                       VALUES ($1, $2, 'out', 'text', 'Sample reply', gen_random_uuid(), $3, ${reply}, $4, $5, $6, ${reply}) RETURNING id`,
          [tenant.id, conv.id, who, status, status === 'failed' ? 'provider_reported' : null, `wamid.sample.out.${suffix}.${j}`])).rows[0]!;
        if (status !== 'failed' && j % 2 === 0) charges.push({ messageId: out.id, at: reply, category: (['service', 'utility', 'marketing'] as const)[j % 3]! });
        if (j % 4 === 0) {
          await c.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data, created_at)
                         VALUES ($1, $2, 'status_changed', $3, '{"to":"resolved","sample":true}', ${reply} + interval '30 minutes')`, [tenant.id, conv.id, who]);
          await c.query(`UPDATE conversations SET status = 'resolved' WHERE id = $1`, [conv.id]);
        }
      }
      // Sample charges for some of those replies (demo rates plus a 20% margin), dated with their messages.
      const card = (await c.query<{ id: string }>(`SELECT id FROM credit_rate_cards WHERE currency = 'SAR' ORDER BY effective_from DESC LIMIT 1`)).rows[0];
      if (card) {
        await c.query('ALTER TABLE credit_entries NO FORCE ROW LEVEL SECURITY');
        await c.query('ALTER TABLE credit_accounts NO FORCE ROW LEVEL SECURITY');
        await c.query('ALTER TABLE credit_entries DISABLE TRIGGER credit_entries_append_only');
        for (const ch of charges) {
          const cost = ch.category === 'marketing' ? 17 : 4;
          const id = (await c.query<{ id: string }>(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, message_id, rate_card_id, market, category, cost_minor, margin_bp)
                                   VALUES ($1, 'charge', $2, $3, $4, 'saudi_arabia', $5, $6, 2000) RETURNING id`,
            [tenant.id, -Math.round(cost * 1.2), ch.messageId, card.id, ch.category, cost])).rows[0]!.id;
          await c.query(`UPDATE credit_entries SET created_at = (SELECT created_at FROM messages WHERE id = $2) WHERE id = $1`, [id, ch.messageId]);
        }
        await c.query('ALTER TABLE credit_entries ENABLE TRIGGER credit_entries_append_only');
        await c.query('ALTER TABLE credit_accounts FORCE ROW LEVEL SECURITY');
        await c.query('ALTER TABLE credit_entries FORCE ROW LEVEL SECURITY');
      }
      for (const t of ['messages', 'conversations', 'conversation_events', 'contact_identifiers', 'contacts']) await c.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      console.error('sample history skipped:', err instanceof Error ? err.message : err);
    } finally { c.release(); await ownerPool.end(); }

    // A platform owner for the platform dashboard (authenticator set up through the real service).
    const staffEmail = `platform.${suffix}@demo.example`;
    const s = await person(staffEmail, 'Platform Owner (Demo)', 'en');
    const { secret } = await auth.beginTotpSetup(s);
    const { authenticator } = await import('otplib');
    await auth.confirmTotp(s, authenticator.generate(secret));
    await notifier.processPending();
    const m = /confirmation code is (\d{4}) (\d{4})/.exec(mailer.lastTo(staffEmail)!.text)!;
    await auth.activateTotp(s, `${m[1]}${m[2]}`);
    const sp = createPool(process.env.DATABASE_URL, 1);
    await sp.query(`INSERT INTO platform_staff (user_id, role, added_by) VALUES ($1, 'platform_owner', 'demo-seed')`, [s.userId]);
    await sp.end();
    staff = { staffEmail, staffTotpSecret: secret };
  }

  console.log(JSON.stringify({ ownerEmail, password: PASSWORD, tenantId: tenant.id, ...(staff ?? {}) }));
  await deps.db.end(); await deps.identityDb.end(); await deps.platformDb.end(); await notify.end(); deps.redis.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
