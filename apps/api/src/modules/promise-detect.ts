/** Finding a commitment with a time in a team reply (W2.6). No database access: pure and testable. */
const DAY = 24 * 3600_000;
// ----------------------------------------------------------------------------------------------------

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
const COMMIT_EN = /\b(i|we)(\s+will|'ll|\s+shall|\s+are going to|\s+am going to)\s+(\w+)/;
/** Arabic first-person future or present of a service verb: سنرسل، سأتصل، بنمر، نزوركم، سوف نتصل … (after folding). */
const AR_VERBS = ['رسل', 'تصل', 'مر', 'زور', 'رجع', 'بلغ', 'جهز', 'راسل', 'حول', 'صلح', 'ركب', 'وصل', 'اكد', 'حجز', 'عطي'];
function arabicCommitment(f: string): string | null {
  for (const w of f.split(/[^\p{L}]+/u)) {
    for (const p of ['سن', 'سا', 'بن', 'ن']) {
      if (w.startsWith(p) && AR_VERBS.some((v) => w.slice(p.length).startsWith(v))) return w;
    }
  }
  return null;
}
const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS_AR = ['الاحد', 'الاثنين', 'الثلاثاء', 'الاربعاء', 'الخميس', 'الجمعه', 'السبت'];

/**
 * A commitment with a time in a team reply, or null. `now` and the company's UTC offset (minutes) decide the
 * proposed deadline: "today" is the end of the company's working day (18:00), "tomorrow" 18:00 the next day,
 * "within N hours/days" exactly that, a weekday 18:00 on the next such day.
 */
export function detectPromise(text: string, now: Date, offsetMinutes: number): { dueAt: Date; matched: string } | null {
  const f = fold(text);
  const en = COMMIT_EN.exec(f);
  const arCommit = en ? null : arabicCommitment(f);
  if (!en && !arCommit) return null;
  const local = new Date(now.getTime() + offsetMinutes * 60_000);           // the company's wall clock, as UTC fields
  const at = (daysAhead: number, hour = 18) => {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysAhead, hour, 0, 0));
    return new Date(d.getTime() - offsetMinutes * 60_000);
  };
  let due: Date | null = null; let matched = '';
  const within = /(within|in)\s+(\d{1,3})\s+(minute|min|hour|hr|day)s?\b/.exec(f)
    ?? /خلال\s+(\d{1,3})?\s*(دقيقه|دقائق|ساعه|ساعات|ساعتين|يوم|ايام|يومين)/.exec(f);
  if (within) {
    matched = within[0];
    if (within[0].startsWith('خلال')) {
      const unit = within[2]!; const n = within[1] ? Number(within[1]) : unit.endsWith('ين') ? 2 : 1;
      const ms = unit.startsWith('دقي') ? 60_000 : unit.startsWith('ساع') ? 3600_000 : DAY;
      due = new Date(now.getTime() + n * ms);
    } else {
      const n = Number(within[2]); const u = within[3]!;
      due = new Date(now.getTime() + n * (u.startsWith('min') ? 60_000 : u.startsWith('h') ? 3600_000 : DAY));
    }
  } else if (/\btoday\b|\bthis (afternoon|evening)\b|اليوم|الليله|العصر|المسا/.test(f)) {
    matched = (/\btoday\b|\bthis (afternoon|evening)\b|اليوم|الليله|العصر|المسا/.exec(f))![0];
    due = at(0); if (due.getTime() <= now.getTime()) due = new Date(now.getTime() + 2 * 3600_000);
  } else if (/\btomorrow\b|بكره|بكرا|غدا|غدًا|باكر/.test(f)) {
    matched = (/\btomorrow\b|بكره|بكرا|غدا|غدًا|باكر/.exec(f))![0];
    due = at(1);
  } else {
    const wd = WEEKDAYS_EN.findIndex((w) => new RegExp(`\\b(on |by |this |next )?${w}\\b`).test(f));
    const wa = wd >= 0 ? -1 : WEEKDAYS_AR.findIndex((w) => f.includes(w) || f.includes(w.replace(/^ال/, '')));
    const idx = wd >= 0 ? wd : wa;
    if (idx >= 0) {
      matched = wd >= 0 ? WEEKDAYS_EN[idx]! : WEEKDAYS_AR[idx]!;
      let ahead = (idx - local.getUTCDay() + 7) % 7; if (ahead === 0) ahead = 7;
      due = at(ahead);
    }
  }
  if (!due) return null;
  const phrase = en ? en[0] : arCommit!;
  return { dueAt: due, matched: `${phrase} … ${matched}`.slice(0, 200) };
}

