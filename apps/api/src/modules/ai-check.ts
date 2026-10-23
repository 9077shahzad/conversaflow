/**
 * Checks on every AI answer before anyone sees it (W2.2, acceptance item 5; review of W2.2/W2.3, H1–H3, L1, L2).
 *
 * The model is never trusted to follow its instructions. An answer is withheld (a person takes over) when:
 *  - it does not cite at least one source it was given;
 *  - it contains a number (price, quantity, time, percentage, phone number) that is not, as a whole number, in a
 *    cited source; or a link that is not exactly a link in a cited source; or says something is free when no cited
 *    source says so;
 *  - it says or promises that something was booked, confirmed, scheduled, cancelled, refunded, paid or received;
 *  - it mixes in letters from other scripts that look like Latin letters (a way to slip past the checks).
 *
 * Everything is compared after the same normalisation: NFKC (full-width digits and dots become ordinary ones),
 * Arabic-Indic and Persian digits to 0–9, invisible characters, tatweel and diacritics removed, alef, ya and ta
 * marbuta forms unified, lower case.
 */
export const CHECKER_VERSION = 'checks-2';

const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/** The normalisation used for every comparison. */
export function normText(s: string): string {
  return s.normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٫]/g, '.').replace(/[٬،]/g, ',')
    .replace(ARABIC_MARKS, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Whole numbers in a text: "1,200.50" → "1200.5", "09" → "9". Thousands separators are ignored. */
export function numbersIn(norm: string): string[] {
  const out: string[] = [];
  for (const m of norm.matchAll(/\d+(?:[.,]\d+)*/g)) {
    let v = m[0];
    // "1,200" and "1.200.000" are thousands; a single "." or "," followed by 1–2 digits is a decimal point.
    const dec = /^(\d+(?:[.,]\d{3})*)[.,](\d{1,2})$/.exec(v);
    v = dec ? `${dec[1]!.replace(/[.,]/g, '')}.${dec[2]}` : v.replace(/[.,]/g, '');
    const [i, f] = v.split('.');
    const int = i!.replace(/^0+(?=\d)/, '');
    const frac = (f ?? '').replace(/0+$/, '');
    out.push(frac ? `${int}.${frac}` : int);
  }
  return out;
}

/** Phone-like digit runs (8 or more digits with spaces, dots, dashes or brackets between), digits only. */
export function phonesIn(norm: string): string[] {
  return [...norm.matchAll(/\+?\(?\d[\d\s().-]{6,}\d/g)].map((m) => m[0].replace(/\D/g, '')).filter((d) => d.length >= 8);
}

/** Links: anything shaped like host.tld (with or without a scheme or path), and IP addresses. */
export function linksIn(norm: string): string[] {
  const re = /\b(?:[a-z][a-z0-9+.-]*:\/\/)?(?:(?:[a-z0-9¡-￿-]+\.)+[a-z¡-￿]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s<>"')]*)?/gi;
  return [...norm.matchAll(re)].map((m) => m[0].replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[.,!?؟،]+$/, '').replace(/\/$/, ''))
    // Bare decimals ("12.50") are numbers, not links.
    .filter((l) => !/^\d+(?:\.\d+)?$/.test(l));
}

const CURRENCY = /(sar|aed|usd|qar|kwd|bhd|omr|eur|gbp|sr|\$|€|£|﷼|ر\.?س|ريال|ريالات|رس|درهم|دراهم|دولار|يورو|هلله|هللات|riyals?|rials?|dirhams?|dollars?|euros?|pounds?|halalas?)/;
const FREE = /\b(free|no charge|complimentary|at no cost)\b|مجان|بدون (رسوم|مقابل|تكلفه)/;

/** Claims or promises of an action this system has not done (it cannot book, refund or take payments). */
const SUCCESS_CLAIMS: RegExp[] = [
  // English: "is/has been/was/will be booked", "we booked", "I've confirmed", "you're all set", "payment received".
  /\b(is|are|was|were|has been|have been|had been|will be|'ll be|got|now)\s+(now\s+|already\s+|successfully\s+|fully\s+)?(booked|confirmed|scheduled|reserved|refunded|paid|approved|cancell?ed|processed|received|credited|charged|dispatched|shipped)\b/,
  /\b(we|i|i've|we've|we have|i have|we've just|i just|we just|we'll|i'll|we will|i will)\s+(have\s+|already\s+|now\s+|just\s+)?(booked|confirmed|scheduled|reserved|refunded|refund|processed|received|cancell?ed|charged|credited|approved|arranged|book|confirm|schedule|reserve|process|cancel|charge|credit|approve|arrange)\b/,
  /\b(booking|appointment|reservation|refund|payment|order|transfer|transaction|visit|slot)\s+(is\s+|has\s+|was\s+|will\s+|went\s+)?(been\s+|be\s+)?(confirmed|approved|processed|completed|received|successful|succeeded|accepted|cancell?ed|on (its|the) way|through|done|booked)\b/,
  /\b(payment|refund|money|amount|transfer)\s+(received|sent|processed|issued|credited)\b/,
  /\byou('re| are)\s+(all set|booked|confirmed|scheduled|good to go)\b/,
  /\b(confirmation|booking|reference|receipt|transaction)\s+(number|no\.?|code|id)\b/,
  // Arabic (normalised: no hamza on alef, ة → ه, ى → ي).
  /(تم|تمت|قد تم|سيتم|راح يتم|بيتم)\s+(بنجاح\s+)?(عمليه\s+)?(ال)?(تاكيد|حجز|استرداد|ارجاع|دفع|سداد|الغاء|اعتماد|تحويل|استلام|جدوله|ترتيب|شحن|ارسال المبلغ)/,
  /(حجز|موعد|طلب|استرداد|دفع|مبلغ|طلبيه|حوال|زيار)(ك|كم|كن|ه|ها|نا)?\s+(مؤكد|موكد|اكد|تاكد|تم|مقبول|ناجح|جاهز|في الطريق)/,
  /(اكدنا|حجزنا|استرجعنا|استردينا|ارجعنا|حولنا|استلمنا|الغينا|رتبنا|جدولنا|اكدت|حجزت|الغيت|استلمت)\b/,
  /(رقم|كود)\s+(ال)?(تاكيد|حجز|مرجع|عمليه|ايصال)/,
  /(مؤكد|موكد)\s+(حجز|موعد)/,
];
const LOOKALIKE_SCRIPTS = /[Ͱ-ϿЀ-ԯⰀ-ⱟꙀ-ꚟᎠ-᏿]/;

export function claimsSuccess(text: string): boolean {
  const n = normText(text);
  return SUCCESS_CLAIMS.some((r) => r.test(n));
}

/** Returns the reasons an AI answer must not be used (empty when it may be). */
export function checkAnswer(text: string, citations: string[], sources: Array<{ id: string; text: string; title: string }>): string[] {
  const reasons: string[] = [];
  if (!text.trim()) return ['no_answer_in_sources'];
  const cited = sources.filter((s) => citations.includes(s.id));
  if (cited.length === 0 || cited.length !== new Set(citations).size) reasons.push('no_valid_citation');
  if (LOOKALIKE_SCRIPTS.test(text.normalize('NFKC'))) reasons.push('unusual_characters');
  const answer = normText(text);
  if (claimsSuccess(text)) reasons.push('claims_unconfirmed_success');
  const corpus = normText(cited.map((s) => `${s.title}\n${s.text}`).join('\n'));

  const known = new Set(numbersIn(corpus));
  const knownPhones = new Set(phonesIn(corpus));
  const phoneDigits = new Set(phonesIn(answer));
  for (const p of phoneDigits) if (!knownPhones.has(p)) { reasons.push('unsupported_number'); break; }
  // Numbers that are part of a known phone number are checked as the phone number above.
  const inPhones = (n: string) => [...phoneDigits].some((p) => knownPhones.has(p) && p.includes(n));
  for (const m of answer.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const n = numbersIn(m[0])[0]!;
    if (known.has(n) || inPhones(n)) continue;
    const around = answer.slice(Math.max(0, m.index! - 12), m.index! + m[0].length + 12);
    reasons.push(CURRENCY.test(around) ? 'unsupported_price' : 'unsupported_number');
    break;
  }
  if (FREE.test(answer) && !FREE.test(corpus)) reasons.push('unsupported_price');

  const knownLinks = new Set(linksIn(corpus));
  for (const l of linksIn(answer)) if (!knownLinks.has(l)) { reasons.push('unsupported_link'); break; }
  return [...new Set(reasons)];
}

const INJECTION = [
  /ignore (all |any |the |your )?(previous|prior|above|earlier)? ?(instructions|messages|rules|prompts?)/, /system prompt/, /you are now/, /\bact as\b/,
  /disregard (your|the|all) (rules|instructions)/, /new instructions/, /developer mode/, /pretend (to be|you)/, /\bjailbreak\b/,
  /تجاهل (كل |جميع )?(ال)?(تعليمات|اوامر|قواعد)/, /انس (ال)?(تعليمات|اوامر)/, /انت الان/, /تعليمات جديده/, /تصرف ك/,
];
/** Customer text that looks like an attempt to change the instructions. */
export function looksLikeInjection(text: string): boolean {
  const n = normText(text);
  return INJECTION.some((r) => r.test(n));
}
