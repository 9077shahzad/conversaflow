import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { AutomationsService } from './automations';
import { AI_LIMITS, searchTerms } from './ai';

/**
 * Guided setup, first version (BRD v1.2 Wave 2, W2.7, CF-EXT-024).
 *
 * - A first-value checklist worked out from what the company has actually done (nothing is ticked by hand).
 * - Starter packs per industry, in English and Arabic: tags, saved replies, knowledge article drafts (unpublished,
 *   so the AI never uses them until a person checks and publishes them) and a suggested automation the person can turn
 *   into a draft (never published). Applying a pack twice adds nothing twice. Each part needs its own permission
 *   (tags, saved replies, knowledge); parts the person may not add are skipped and listed (review of W2.7).
 * - "Describe it in your own words": a plain description of an automation becomes a draft the company can inspect,
 *   rehearse and publish. This version understands a fixed set of phrasings (listed in the screen's help) and says
 *   plainly when it did not understand, rather than guessing.
 * Sample workspaces are not in this version (see the wave report).
 */
type Pack = {
  key: string;
  tags: Array<{ name: string; color: string }>;
  replies: Array<{ title: string; body: string; language: 'en' | 'ar' }>;
  articles: Array<{ title: string; body: string; language: 'en' | 'ar' }>;
  automation: { name: string; description: string; descriptionAr: string };
};

export const PACKS: Pack[] = [
  {
    key: 'home_services',
    tags: [{ name: 'New request', color: 'teal' }, { name: 'Emergency', color: 'red' }, { name: 'Quote sent', color: 'amber' }, { name: 'Visit booked', color: 'green' }],
    replies: [
      { title: 'Ask for details', language: 'en', body: 'Thank you {name}. Could you send a photo of the problem and your area, so we can send the right technician?' },
      { title: 'طلب التفاصيل', language: 'ar', body: 'شكرًا {name}. هل يمكنك إرسال صورة للمشكلة واسم الحي، حتى نرسل الفني المناسب؟' },
      { title: 'Visit window', language: 'en', body: 'Our technician can visit between [time] and [time]. Does that suit you?' },
      { title: 'موعد الزيارة', language: 'ar', body: 'يمكن للفني زيارتك بين [الوقت] و[الوقت]. هل يناسبك ذلك؟' },
    ],
    articles: [
      { title: 'Services and areas (edit before publishing)', language: 'en', body: 'We repair air conditioners, plumbing and electrical faults. We serve [your cities]. Write your real services, areas and prices here, then publish.' },
      { title: 'الخدمات والمناطق (عدّلها قبل النشر)', language: 'ar', body: 'نصلح المكيفات والسباكة والأعطال الكهربائية. نخدم [مدنك]. اكتب خدماتك ومناطقك وأسعارك الحقيقية هنا ثم انشرها.' },
    ],
    automation: { name: 'After-hours reply (starter)', description: 'When a customer writes outside business hours, reply "Thank you, we are closed now and will reply first thing in the morning." and hand over to the team.',
      descriptionAr: 'عندما يكتب العميل خارج أوقات العمل رد "شكرًا لتواصلك، نحن خارج أوقات العمل الآن وسنرد عليك صباحًا." ثم حوّل إلى الفريق' },
  },
  {
    key: 'clinic',
    tags: [{ name: 'Appointment', color: 'teal' }, { name: 'Results', color: 'blue' }, { name: 'Urgent', color: 'red' }],
    replies: [
      { title: 'Appointment request', language: 'en', body: 'Thank you {name}. Which day and time suit you, and which doctor or service would you like?' },
      { title: 'طلب موعد', language: 'ar', body: 'شكرًا {name}. ما اليوم والوقت المناسبان لك، وما الطبيب أو الخدمة التي تريدها؟' },
      { title: 'Not for emergencies', language: 'en', body: 'For a medical emergency, please call 997 or go to the nearest emergency department. This chat is not monitored for emergencies.' },
      { title: 'ليس للطوارئ', language: 'ar', body: 'في حالة الطوارئ الطبية يُرجى الاتصال على 997 أو التوجه إلى أقرب قسم طوارئ. هذه المحادثة غير مخصصة للطوارئ.' },
    ],
    articles: [
      { title: 'Clinic hours and services (edit before publishing)', language: 'en', body: 'Write your clinic\'s opening hours, services, doctors and booking rules here. Do not include medical advice. Publish when checked.' },
      { title: 'مواعيد العيادة وخدماتها (عدّلها قبل النشر)', language: 'ar', body: 'اكتب هنا مواعيد عمل العيادة وخدماتها وأطباءها وقواعد الحجز. لا تضع نصائح طبية. انشرها بعد المراجعة.' },
    ],
    automation: { name: 'Hand over every message (starter)', description: 'When a customer writes, hand over to the team.', descriptionAr: 'عندما يكتب العميل حوّل إلى الفريق' },
  },
  {
    key: 'restaurant',
    tags: [{ name: 'Order', color: 'green' }, { name: 'Reservation', color: 'teal' }, { name: 'Complaint', color: 'red' }],
    replies: [
      { title: 'Menu and order', language: 'en', body: 'Hello {name}! Here is our menu: [link]. What would you like to order, and is it for pickup or delivery?' },
      { title: 'القائمة والطلب', language: 'ar', body: 'أهلًا {name}! هذه قائمتنا: [الرابط]. ماذا تحب أن تطلب، وهل هو استلام أم توصيل؟' },
    ],
    articles: [
      { title: 'Opening hours and delivery (edit before publishing)', language: 'en', body: 'Write your opening hours, delivery areas, minimum order and fees here, then publish.' },
      { title: 'مواعيد العمل والتوصيل (عدّلها قبل النشر)', language: 'ar', body: 'اكتب هنا مواعيد العمل ومناطق التوصيل والحد الأدنى للطلب والرسوم، ثم انشرها.' },
    ],
    automation: { name: 'Menu keyword (starter)', description: 'When a customer writes "menu", reply "Here is our menu: [link]".', descriptionAr: 'عندما يكتب العميل "القائمة" رد "هذه قائمتنا: [الرابط]"' },
  },
];

// --- Plain description → draft -----------------------------------------------------------------------------

type Draft = { trigger: { kind: 'message_received' | 'conversation_started'; keywords: string[] }; start: string | null; steps: Array<Record<string, unknown>> };

/**
 * Understands: "when a customer writes [outside business hours | "<words>" | for the first time]", then one or more of
 * reply "<text>", wait N minutes/hours, add the tag "<name>", hand over to the team, and the Arabic equivalents
 * ("عندما يكتب العميل", "خارج أوقات العمل", "رد", "انتظر", "أضف الوسم", "حوّل إلى الفريق"). Anything else: not understood.
 */
const MAX_STEPS = 30;
const ACTION_WORDS = /^(reply|answer|respond|and|then|wait|add|tag|hand|pass|رد|ردّ|أرسل|ارسل|ثم|و|انتظر|أضف|اضف|ضع|حول|حوّل|سلم|سلّم)$/i;
/**
 * The keyword after "writes / says / sends / types" (or يكتب / يرسل / يقول), allowing up to three words in between
 * ("writes the word "menu"", "يكتب العميل "الأسعار""), but never across an action ("writes, then reply "…"").
 * Returns undefined when there is no such verb, null when the verb is followed by a quote it could not read.
 */
function keywordAfterVerb(s: string): string | null | undefined {
  const verb = /(?:^|[^\p{L}])(writes|says|sends|types|يكتب|يرسل|يقول)(?=[^\p{L}]|$)/giu;
  for (const m of s.matchAll(verb)) {
    const rest = s.slice(m.index! + m[0].length);
    const q = rest.indexOf('"');
    if (q < 0) continue;
    const between = rest.slice(0, q).trim();
    const words = between ? between.split(/\s+/) : [];
    if (between.match(/[,.;،؛]/) || words.length > 3 || words.some((w) => ACTION_WORDS.test(w))) continue;
    const close = rest.indexOf('"', q + 1);
    if (close < 0) return null;
    const kw = rest.slice(q + 1, close).trim();
    return kw.length >= 1 && kw.length <= 60 ? kw : null;
  }
  return undefined;
}

/**
 * Understands: "when a customer writes [outside business hours | "<words>" | for the first time]", then one or more of
 * reply "<text>", wait N minutes/hours, add the tag "<name>", hand over to the team, and the Arabic equivalents
 * ("عندما يكتب العميل", "خارج أوقات العمل", "رد", "انتظر", "أضف الوسم", "حوّل إلى الفريق"). Anything else, an unknown
 * tag, a zero wait or too many steps: not understood, with the reason. Words inside quoted replies are never read as
 * instructions (review of W2.7).
 */
export function describeToDraft(text: string, tagIds: Map<string, string>): { draft: Draft; understood: string[]; notUnderstood: boolean; reason?: string } {
  const s = text.normalize('NFKC').replace(/[“”«»]/g, '"').trim();
  // Quoted text blanked out (same length, so positions still line up) for everything except replies and names.
  const bare = s.replace(/"[^"]*"/g, (m) => ' '.repeat(m.length)).toLowerCase();
  const understood: string[] = [];
  const no = (reason: string) => ({ draft: { trigger: { kind: 'message_received' as const, keywords: [] }, start: null, steps: [] }, understood, notUnderstood: true, reason });
  if ((s.match(/"/g) ?? []).length % 2 === 1) return no('quotes');
  const trigger: Draft['trigger'] = { kind: 'message_received', keywords: [] };
  const kw = keywordAfterVerb(s);
  if (kw === null) return no('keyword');
  if (kw) { trigger.keywords = [kw]; understood.push('keyword'); }
  if (/first time|اول مره|أول مرة|لأول مرة|لاول مره/.test(bare)) { trigger.kind = 'conversation_started'; understood.push('first_message'); }
  const after = /outside (business|working|opening) hours|after hours|خارج (اوقات|أوقات|ساعات) العمل|بعد الدوام/.test(bare);
  const steps: Array<Record<string, unknown>> = [];
  let n = 0;
  const id = () => `step-${++n}`;
  const ordered: Array<{ at: number; step: Record<string, unknown> }> = [];
  for (const m of s.matchAll(/(?<![\p{L}])(?:reply|answer|respond|رد|ردّ|أرسل|ارسل)\s*(?:with|by saying|بـ|ب)?\s*"([^"]{1,1000})"/giu)) {
    if (bare[m.index!] === ' ' && s[m.index!] !== ' ') continue;   // the word "reply" inside another quote
    const t = m[1]!.trim();
    ordered.push({ at: m.index!, step: { kind: 'send_reply', text: /[\u0600-\u06FF]/.test(t) ? { ar: t } : { en: t } } });
  }
  for (const m of bare.matchAll(/(?:wait|انتظر)\s+(\d{1,4})\s*(minutes?|mins?|hours?|days?|دقيقه|دقيقة|دقائق|ساعه|ساعة|ساعات|يوم|ايام|أيام)/g)) {
    const v = Number(m[1]); const u = m[2]!;
    if (v < 1) return no('wait');
    const minutes = /hour|ساع/.test(u) ? v * 60 : /day|يوم|ايام|أيام/.test(u) ? v * 1440 : v;
    ordered.push({ at: m.index!, step: { kind: 'wait', minutes: Math.min(minutes, 10080) } });
  }
  for (const m of s.matchAll(/(?<![\p{L}])(?:add the tag|tag it|add tag|أضف الوسم|اضف الوسم|ضع الوسم)\s*"([^"]{1,40})"/giu)) {
    if (bare[m.index!] === ' ' && s[m.index!] !== ' ') continue;
    const tagId = tagIds.get(m[1]!.trim().toLowerCase());
    if (!tagId) return no('unknown_tag');
    ordered.push({ at: m.index!, step: { kind: 'add_tag', tagId } });
  }
  for (const m of bare.matchAll(/hand (it )?over to (the )?team|pass (it )?to (the )?team|حو[ّ]?ل (الى|إلى) الفريق|سلّم للفريق|سلم للفريق/g)) {
    ordered.push({ at: m.index!, step: { kind: 'handoff', note: 'Handed over by the automation' } });
  }
  ordered.sort((a, b) => a.at - b.at);
  const actions = ordered.map((o) => o.step);
  if (actions.length === 0) return no('no_steps');
  if (actions.length + (after ? 1 : 0) > MAX_STEPS) return no('too_many_steps');
  understood.push(...actions.map((a) => String(a.kind)));
  const chainIds = actions.map(() => id());
  const chain = actions.map((a, i) => ({ id: chainIds[i]!, ...a, next: chainIds[i + 1] ?? null }));
  if (after) {
    const cond = { id: 'step-hours', kind: 'condition', if: { kind: 'within_business_hours' }, then: null, else: chainIds[0]! };
    steps.push(cond, ...chain);
    understood.push('outside_hours');
    return { draft: { trigger, start: 'step-hours', steps }, understood, notUnderstood: false };
  }
  steps.push(...chain);
  return { draft: { trigger, start: chainIds[0]!, steps }, understood, notUnderstood: false };
}

const Describe = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().min(5).max(2000) }).strict();

export class SetupService {
  constructor(private readonly deps: Deps) {}

  /** What the company has done so far, worked out from its records. */
  checklist(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const q = async (sql: string) => !!(await tx.query(sql)).rowCount;
      const items = {
        hours: await q(`SELECT 1 FROM tenant_settings WHERE business_hours IS NOT NULL AND business_hours::text <> '{}' LIMIT 1`),
        channel: await q(`SELECT 1 FROM channel_connections WHERE status = 'active' LIMIT 1`),
        team: await q(`SELECT 1 FROM memberships WHERE status = 'active' OFFSET 1 LIMIT 1`),
        firstReply: await q(`SELECT 1 FROM messages WHERE direction = 'out' AND sent_by_membership_id IS NOT NULL LIMIT 1`),
        savedReply: await q(`SELECT 1 FROM saved_replies LIMIT 1`),
        knowledge: await q(`SELECT 1 FROM knowledge_articles WHERE published LIMIT 1`),
        automation: await q(`SELECT 1 FROM workflows WHERE status = 'active' LIMIT 1`),
        notifications: await q(`SELECT 1 FROM push_subscriptions LIMIT 1`),
      };
      const done = Object.values(items).filter(Boolean).length;
      return { items, done, total: Object.keys(items).length };
    });
  }

  /** The packs, and which parts this person may add. */
  packs(actor: TenantActor) {
    const may = { tags: actor.permissions.has('tags.manage'), replies: actor.permissions.has('saved_replies.manage'),
      articles: actor.permissions.has('knowledge.manage'), automation: actor.permissions.has('automations.manage') };
    return PACKS.map((p) => ({ key: p.key, tags: p.tags.length, replies: p.replies.length, articles: p.articles.length,
      automation: { name: p.automation.name, description: p.automation.description, descriptionAr: p.automation.descriptionAr }, may }));
  }

  async applyPack(actor: TenantActor, key: string) {
    const pack = PACKS.find((p) => p.key === key);
    if (!pack) throw Errors.notFound('Starter pack');
    const may = { tags: actor.permissions.has('tags.manage'), replies: actor.permissions.has('saved_replies.manage'), articles: actor.permissions.has('knowledge.manage') };
    if (!may.tags && !may.replies && !may.articles) throw Errors.forbidden('You cannot add tags, saved replies or knowledge articles.');
    const added = await withContext(this.deps.db, actor, async (tx) => {
      // One pack application at a time per company, so two clicks never add anything twice.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 71))', [actor.tenantId]);
      const out = { tags: 0, replies: 0, articles: 0, skipped: [] as string[], limitReached: [] as string[] };
      const audit = (action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) =>
        AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action, ip: actor.ip, targetType, targetId, metadata: { ...metadata, pack: key } });
      const room = async (sql: string, limit: number, want: number) => Math.max(0, Math.min(want, limit - (await count(tx, sql))));
      if (!may.tags) out.skipped.push('tags');
      else {
        let left = await room('SELECT count(*)::int AS n FROM tags', 200, pack.tags.length);
        for (const t of pack.tags) {
          if (left <= 0) { out.limitReached.push('tags'); break; }
          const r = await tx.query<{ id: string }>(`INSERT INTO tags (tenant_id, name, color, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
            [actor.tenantId, t.name, t.color, actor.membershipId]);
          if (r.rows[0]) { out.tags++; left--; await audit('tag.created', 'tag', r.rows[0].id, { name: t.name }); }
        }
      }
      if (!may.replies) out.skipped.push('replies');
      else {
        let left = await room('SELECT count(*)::int AS n FROM saved_replies', 500, pack.replies.length);
        for (const r0 of pack.replies) {
          if (left <= 0) { out.limitReached.push('replies'); break; }
          const r = await tx.query<{ id: string }>(`INSERT INTO saved_replies (tenant_id, title, body, language, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT DO NOTHING RETURNING id`,
            [actor.tenantId, r0.title, r0.body, r0.language, actor.membershipId]);
          if (r.rows[0]) { out.replies++; left--; await audit('saved_reply.created', 'saved_reply', r.rows[0].id, { title: r0.title }); }
        }
      }
      if (!may.articles) out.skipped.push('articles');
      else {
        let left = await room('SELECT count(*)::int AS n FROM knowledge_articles', AI_LIMITS.maxArticles, pack.articles.length);
        for (const a of pack.articles) {
          if (left <= 0) { out.limitReached.push('articles'); break; }
          // Drafts only: the AI uses an article once a person has checked and published it.
          const r = await tx.query<{ id: string }>(`INSERT INTO knowledge_articles (tenant_id, title, body, language, published, terms, updated_by) SELECT $1, $2, $3, $4, false, $5, $6
                                    WHERE NOT EXISTS (SELECT 1 FROM knowledge_articles WHERE lower(title) = lower($2)) RETURNING id`,
            [actor.tenantId, a.title, a.body, a.language, searchTerms(`${a.title} ${a.body}`), actor.membershipId]);
          if (r.rows[0]) { out.articles++; left--; await audit('knowledge.article_created', 'knowledge_article', r.rows[0].id, { title: a.title, published: false }); }
        }
      }
      await audit('setup.pack_applied', 'tenant', actor.tenantId, { tags: out.tags, replies: out.replies, articles: out.articles, skipped: out.skipped });
      return out;
    });
    // The automation is offered, not created: making the draft goes through "describe", which carries that
    // permission's own sign-in checks.
    return { ...added, automation: { name: pack.automation.name, description: pack.automation.description, descriptionAr: pack.automation.descriptionAr } };
  }

  /** A plain description becomes an automation draft (never published here). */
  async fromDescription(actor: TenantActor, input: unknown) {
    const body = parse(Describe, input);
    const tags = await withContext(this.deps.db, actor, async (tx) => new Map((await tx.query<{ id: string; name: string }>('SELECT id, name FROM tags')).rows.map((t) => [t.name.toLowerCase(), t.id])));
    const r = describeToDraft(body.description, tags);
    if (r.notUnderstood) {
      const why: Record<string, string> = { unknown_tag: 'It names a tag the company does not have yet; add the tag first.', wait: 'A wait must be at least one minute.',
        too_many_steps: `An automation can have up to ${MAX_STEPS} steps.`, keyword: 'The words the customer writes could not be read; put them in quotes.', quotes: 'A quotation mark is not closed.' };
      throw new AppError(422, 'not_understood', `This description could not be turned into steps. ${why[r.reason ?? ''] ?? 'Use the phrasings shown in the help, or build it step by step.'}`, { reason: r.reason ?? 'no_steps' });
    }
    const created = await new AutomationsService(this.deps).create(actor, { name: body.name, draft: r.draft });
    return { id: created.id, understood: r.understood, draft: r.draft };
  }
}

async function count(tx: Tx, sql: string) { return Number((await tx.query<{ n: number }>(sql)).rows[0]!.n); }

