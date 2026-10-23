/**
 * Finding a commitment with a time in a team reply (W2.6). No database access: pure and testable.
 *
 * Reviewed (review of W2.6): words are compared as whole words (Arabic too), negations and questions are not
 * promises, longer time words are tried before shorter ones, a stated clock time is used, and deadlines are worked
 * out in the company's time zone on the day they fall (daylight saving included). Deadlines are kept between five
 * minutes and a year away.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAX_AHEAD = 365 * DAY;

const fold = (s: string) => s.normalize('NFKC').toLowerCase()
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
const words = (f: string) => f.split(/[^\p{L}\p{N}']+/u).filter(Boolean);

const COMMIT_EN = /\b(i|we)(\s+will|'ll|\s+shall|\s+are going to|\s+am going to)\s+(\w+)/;
const NEGATION_EN = /\b(i|we)(\s+will|'ll|\s+shall|\s+are going to|\s+am going to)?\s+(not|never|n't|be unable|be not able)\b|\b(won't|wont|cannot|can't|shan't)\b/;
/** Arabic first-person future or present of a service verb: سنرسل، سأتصل، بنمر، نزوركم، سوف نتصل، راح اتصل … */
const AR_VERBS = ['رسل', 'تصل', 'مر', 'زور', 'رجع', 'بلغ', 'جهز', 'راسل', 'حول', 'صلح', 'ركب', 'وصل', 'اكد', 'حجز', 'عطي'];
const AR_NEGATORS = new Set(['لن', 'لا', 'ما', 'مش', 'مو', 'ماراح', 'مب', 'ماني', 'مانقدر', 'مانقدرش']);
function arabicCommitment(ws: string[]): string | null {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const lead = i > 0 && ['راح', 'رح', 'سوف', 'بنقدر', 'ح'].includes(ws[i - 1]!);
    for (const p of lead ? ['ن', 'ا', 'سن', 'سا', 'بن', 'ب'] : ['سن', 'سا', 'بن', 'بت', 'ن']) {
      if (w.startsWith(p) && AR_VERBS.some((v) => w.slice(p.length).startsWith(v))) {
        // "لن نرسل", "ما راح نرسل", "مش بنرسل": not a promise.
        const before = ws.slice(Math.max(0, i - 3), i);
        if (before.some((b) => AR_NEGATORS.has(b))) return null;
        return lead ? `${ws[i - 1]} ${w}` : w;
      }
    }
  }
  return null;
}
const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS_AR = ['الاحد', 'الاثنين', 'الثلاثاء', 'الاربعاء', 'الخميس', 'الجمعه', 'السبت'];

/** UTC offset in minutes of a time zone at an instant (daylight saving included). */
export function offsetAt(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).reduce<Record<string, number>>((o, p) => (p.type === 'literal' ? o : { ...o, [p.type]: Number(p.value) }), {});
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MIN);
}

/** "at 10", "at 10:30", "at 4pm", "الساعه 10" → [hour, minute] on the company's clock. */
function clockTime(f: string): [number, number] | null {
  const m = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(f) ?? /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(f);
  const a = /(?:^|\s)الساعه\s+(\d{1,2})(?::(\d{2}))?\s*(صباحا|الصبح|مساء|المساء|العصر|الظهر)?/.exec(f);
  if (m) {
    let h = Number(m[1]); const min = m[2] ? Number(m[2]) : 0;
    if (m[3] === 'pm' && h < 12) h += 12; if (m[3] === 'am' && h === 12) h = 0;
    return h <= 23 && min <= 59 ? [h, min] : null;
  }
  if (a) {
    let h = Number(a[1]); const min = a[2] ? Number(a[2]) : 0;
    if (a[3] && /مساء|المساء|العصر/.test(a[3]) && h < 12) h += 12;
    if (a[3] === 'الظهر' && h < 6) h += 12;
    return h <= 23 && min <= 59 ? [h, min] : null;
  }
  return null;
}

/**
 * A commitment with a time in a team reply, or null. `zone` is the company's IANA time zone (or a fixed UTC
 * offset in minutes, for tests): "today" is 18:00, "tomorrow" 18:00 the next day, "within N hours/days" exactly
 * that, a weekday 18:00 on the next such day; a stated clock time replaces 18:00.
 */
export function detectPromise(text: string, now: Date, zone: string | number): { dueAt: Date; matched: string } | null {
  // Questions are not promises ("shall we send the technician tomorrow?").
  if (/[?؟]\s*$/.test(text.trim())) return null;
  const f = fold(text);
  const ws = words(f);
  const en = COMMIT_EN.exec(f);
  if (en && NEGATION_EN.test(f)) return null;
  const arCommit = en ? null : arabicCommitment(ws);
  if (!en && !arCommit) return null;
  const off = (at: Date) => (typeof zone === 'number' ? zone : offsetAt(zone, at));
  const local = new Date(now.getTime() + off(now) * MIN);       // the company's wall clock, as UTC fields
  const clock = clockTime(f);
  const at = (daysAhead: number) => {
    const [h, m] = clock ?? [18, 0];
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysAhead, h, m, 0);
    // The offset on that day, not today's (daylight saving).
    const guess = new Date(wall - off(now) * MIN);
    return new Date(wall - off(guess) * MIN);
  };
  const has = (w: string) => ws.includes(w);
  let due: Date | null = null; let matched = '';
  const withinEn = /(?:^|\s)(within|in)\s+(\d{1,3}|an?|one)\s+(minutes?|mins?|hours?|hrs?|days?)\b/.exec(f);
  const withinAr = /خلال\s+(\d{1,3})?\s*(ساعتين|ساعات|ساعه|يومين|ايام|يوم|دقيقتين|دقائق|دقيقه)(?=[^\p{L}]|$)/u.exec(f);
  if (withinEn) {
    matched = withinEn[0].trim();
    const n = /^\d/.test(withinEn[2]!) ? Number(withinEn[2]) : 1; const u = withinEn[3]!;
    due = new Date(now.getTime() + n * (u.startsWith('m') ? MIN : u.startsWith('h') ? HOUR : DAY));
  } else if (withinAr) {
    matched = withinAr[0];
    const unit = withinAr[2]!; const n = withinAr[1] ? Number(withinAr[1]) : unit.endsWith('ين') ? 2 : 1;
    due = new Date(now.getTime() + n * (unit.startsWith('دقي') ? MIN : unit.startsWith('ساع') ? HOUR : DAY));
  } else if (/\btoday\b|\bthis (afternoon|evening)\b|\btonight\b/.test(f) || ['اليوم', 'الليله', 'العصر', 'المسا', 'المساء'].some(has)) {
    matched = (/\btoday\b|\bthis (afternoon|evening)\b|\btonight\b/.exec(f)?.[0]) ?? ['اليوم', 'الليله', 'العصر', 'المسا', 'المساء'].find(has)!;
    due = at(0); if (due.getTime() <= now.getTime()) due = new Date(now.getTime() + 2 * HOUR);
  } else if (/\btomorrow\b/.test(f) || ['بكره', 'بكرا', 'غدا', 'باكر'].some(has)) {
    matched = (/\btomorrow\b/.exec(f)?.[0]) ?? ['بكره', 'بكرا', 'غدا', 'باكر'].find(has)!;
    due = at(1);
  } else {
    const wd = WEEKDAYS_EN.findIndex((w) => new RegExp(`\\b${w}\\b`).test(f));
    // Arabic weekdays as whole words: with the article, or without it after "يوم" ("يوم الخميس" / "يوم خميس").
    const wa = wd >= 0 ? -1 : WEEKDAYS_AR.findIndex((w) => has(w) || ws.some((x, i) => x === w.replace(/^ال/, '') && ws[i - 1] === 'يوم'));
    const idx = wd >= 0 ? wd : wa;
    if (idx >= 0) {
      matched = wd >= 0 ? WEEKDAYS_EN[idx]! : WEEKDAYS_AR[idx]!;
      const today = local.getUTCDay();
      let ahead = (idx - today + 7) % 7;
      // The same weekday today: later today if the stated time has not passed, otherwise next week.
      if (ahead === 0 && at(0).getTime() <= now.getTime()) ahead = 7;
      due = at(ahead);
    }
  }
  if (!due) return null;
  // Between five minutes and a year away.
  if (due.getTime() < now.getTime() + 5 * MIN) due = new Date(now.getTime() + 5 * MIN);
  if (due.getTime() > now.getTime() + MAX_AHEAD) return null;
  const phrase = en ? en[0] : arCommit!;
  return { dueAt: due, matched: `${phrase} … ${matched}`.slice(0, 200) };
}
