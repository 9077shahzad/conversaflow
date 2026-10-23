/**
 * Conversa Operator: deterministic pricing (addendum FR-06, AC-04, AC-05). No database access, no AI: the same rate
 * card and request always give the same quote, to the minor unit.
 *
 * - All amounts are integers in the currency's minor unit (halalas, fils). Currencies with three decimals (KWD, BHD,
 *   OMR) are supported by the minor-unit table; rounding is half-up, applied once per line and once for tax.
 * - Tax is a rate in basis points on the taxable amount (after discount); tax-inclusive rate cards are not supported
 *   in this version and are refused by the rate-card schema.
 * - A service marked "inspection" never gets a repair price: the quote is for the inspection visit only, and says so.
 * - Discounts come only from the rate card (quantity tiers) or from an approved manual discount; the quote records
 *   which, and a manual discount above the card's limit needs approval.
 */
import { z } from 'zod';

export const MINOR_UNITS: Record<string, number> = { SAR: 2, AED: 2, QAR: 2, USD: 2, EUR: 2, KWD: 3, BHD: 3, OMR: 3 };
export const CURRENCIES = Object.keys(MINOR_UNITS) as [string, ...string[]];

const minor = z.number().int().min(0).max(1_000_000_000);
export const RateService = z.object({
  serviceKey: z.string().regex(/^[a-z0-9_]{2,40}$/),
  nameEn: z.string().trim().min(2).max(80),
  nameAr: z.string().trim().min(2).max(80),
  kind: z.enum(['fixed', 'inspection']),
  /** Price per unit (fixed) or of the inspection visit (inspection), minor units. */
  unitPrice: minor,
  minQuantity: z.number().int().min(1).max(100).default(1),
  maxQuantity: z.number().int().min(1).max(100).default(20),
  /** Quantity tiers: from this many units, this percentage off the line (basis points, at most 50%). */
  tiers: z.array(z.object({ fromQuantity: z.number().int().min(2).max(100), discountBp: z.number().int().min(1).max(5000) })).max(5).default([]),
  /** Estimated cost per unit for the margin check (never shown to the customer). Absent: margin unknown. */
  unitCost: minor.optional(),
}).strict();
export const RateCard = z.object({
  currency: z.enum(CURRENCIES),
  taxRateBp: z.number().int().min(0).max(5000),
  taxLabel: z.string().trim().min(1).max(30),
  calloutCharge: minor.default(0),
  minimumCharge: minor.default(0),
  /** Largest manual discount a person with quote permission may give without approval (basis points). */
  manualDiscountLimitBp: z.number().int().min(0).max(5000).default(0),
  /** Quotes at or above this total need approval before they are sent (minor units; absent: never). */
  approvalAbove: minor.optional(),
  /** Least acceptable estimated margin (basis points); lower needs approval. Absent: not checked. */
  minMarginBp: z.number().int().min(-10000).max(10000).optional(),
  depositBp: z.number().int().min(0).max(10000).default(0),
  validityHours: z.number().int().min(1).max(24 * 30).default(48),
  services: z.array(RateService).min(1).max(100),
  /** Extra travel charge per service area key (minor units). Areas not listed are outside the service area. */
  areas: z.record(z.string().regex(/^[a-z0-9_]{2,60}$/), minor).refine((a) => Object.keys(a).length >= 1 && Object.keys(a).length <= 500, 'List 1 to 500 service areas.'),
}).strict().superRefine((c, ctx) => {
  const keys = new Set<string>();
  for (const s of c.services) {
    if (keys.has(s.serviceKey)) ctx.addIssue({ code: 'custom', message: `Service ${s.serviceKey} is listed twice.` });
    keys.add(s.serviceKey);
    if (s.minQuantity > s.maxQuantity) ctx.addIssue({ code: 'custom', message: `Service ${s.serviceKey}: minimum quantity is above the maximum.` });
    const from = s.tiers.map((t) => t.fromQuantity);
    if (new Set(from).size !== from.length) ctx.addIssue({ code: 'custom', message: `Service ${s.serviceKey}: two tiers start at the same quantity.` });
  }
});
export type RateCard = z.infer<typeof RateCard>;

export type PriceRequest = { lines: Array<{ serviceKey: string; quantity: number }>; areaKey: string; manualDiscountBp?: number };
export type PricedLine = { serviceKey: string; kind: 'fixed' | 'inspection'; quantity: number; unitPrice: number; gross: number; tierDiscount: number; net: number };
export type Priced = {
  ok: true; currency: string; lines: PricedLine[]; callout: number; travel: number; minimumTopUp: number; manualDiscount: number;
  taxable: number; taxRateBp: number; tax: number; total: number; deposit: number; inspectionOnly: boolean;
  estimatedCost: number | null; estimatedMarginBp: number | null; needsApproval: string[];
};
export type PriceRefusal = { ok: false; reason: 'unknown_service' | 'outside_area' | 'quantity' | 'mixed_inspection' | 'discount_too_large' | 'empty' | 'duplicate_line' | 'too_large'; detail?: string };
/** The largest quote total accepted (minor units): keeps every intermediate amount exact in floating point. */
export const MAX_TOTAL_MINOR = 10_000_000_000;

/** amount × bp / 10 000, rounded half up, in exact integer arithmetic (review of Operator slice 1, L1). */
const pct = (amount: number, bp: number) => Number((BigInt(amount) * BigInt(bp) * 2n + 10_000n) / 20_000n);

export function priceQuote(card: RateCard, req: PriceRequest): Priced | PriceRefusal {
  if (req.lines.length === 0) return { ok: false, reason: 'empty' };
  // One line per service (review L2): quantities go on the line, so limits and tiers apply as written.
  if (new Set(req.lines.map((l) => l.serviceKey)).size !== req.lines.length) return { ok: false, reason: 'duplicate_line' };
  if (!(req.areaKey in card.areas)) return { ok: false, reason: 'outside_area', detail: req.areaKey };
  const byKey = new Map(card.services.map((s) => [s.serviceKey, s]));
  const lines: PricedLine[] = [];
  let cost = 0; let costKnown = true;
  for (const l of req.lines) {
    const s = byKey.get(l.serviceKey);
    if (!s) return { ok: false, reason: 'unknown_service', detail: l.serviceKey };
    if (!Number.isInteger(l.quantity) || l.quantity < s.minQuantity || l.quantity > s.maxQuantity) return { ok: false, reason: 'quantity', detail: l.serviceKey };
    // An inspection is one visit, whatever the number of units: the price of the repair is not known yet.
    const qty = s.kind === 'inspection' ? 1 : l.quantity;
    const gross = s.unitPrice * qty;
    const tier = s.kind === 'fixed' ? [...s.tiers].sort((a, b) => b.fromQuantity - a.fromQuantity).find((t) => qty >= t.fromQuantity) : undefined;
    const tierDiscount = tier ? pct(gross, tier.discountBp) : 0;
    lines.push({ serviceKey: s.serviceKey, kind: s.kind, quantity: qty, unitPrice: s.unitPrice, gross, tierDiscount, net: gross - tierDiscount });
    if (s.unitCost === undefined) costKnown = false; else cost += s.unitCost * qty;
  }
  const kinds = new Set(lines.map((l) => l.kind));
  if (kinds.size > 1) return { ok: false, reason: 'mixed_inspection' };
  const inspectionOnly = kinds.has('inspection');
  const manualBp = req.manualDiscountBp ?? 0;
  if (manualBp < 0 || manualBp > 5000 || !Number.isInteger(manualBp)) return { ok: false, reason: 'discount_too_large' };
  const linesNet = lines.reduce((a, l) => a + l.net, 0);
  const callout = card.calloutCharge;
  const travel = card.areas[req.areaKey]!;
  // A manual discount applies to the service lines only, never to callout or travel; the minimum charge applies after
  // it, so a discount never takes the price under the minimum (review M5).
  const manualDiscount = pct(linesNet, manualBp);
  const beforeMinimum = linesNet - manualDiscount + callout + travel;
  const minimumTopUp = Math.max(0, card.minimumCharge - beforeMinimum);
  const taxable = beforeMinimum + minimumTopUp;
  const tax = pct(taxable, card.taxRateBp);
  const total = taxable + tax;
  if (total > MAX_TOTAL_MINOR) return { ok: false, reason: 'too_large' };
  const deposit = pct(total, card.depositBp);
  // Margin on the service work only: callout and travel have no cost entered, so counting them would overstate it (L3).
  const revenue = linesNet - manualDiscount;
  const estimatedCost = costKnown ? cost : null;
  const estimatedMarginBp = costKnown && revenue > 0 ? Math.round(((revenue - cost) * 10_000) / revenue) : null;
  const needsApproval: string[] = [];
  if (manualBp > card.manualDiscountLimitBp) needsApproval.push('manual_discount');
  if (card.approvalAbove !== undefined && total >= card.approvalAbove) needsApproval.push('amount');
  if (card.minMarginBp !== undefined && estimatedMarginBp !== null && estimatedMarginBp < card.minMarginBp) needsApproval.push('margin');
  return { ok: true, currency: card.currency, lines, callout, travel, minimumTopUp, manualDiscount, taxable, taxRateBp: card.taxRateBp, tax, total, deposit,
    inspectionOnly, estimatedCost, estimatedMarginBp, needsApproval };
}

/** "1,234.50 SAR" style text for messages, with the currency's own number of decimals. */
export function formatMoney(amountMinor: number, currency: string, locale: 'en' | 'ar' = 'en'): string {
  const digits = MINOR_UNITS[currency] ?? 2;
  const n = new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(amountMinor / 10 ** digits);
  return locale === 'ar' ? `${n} ${currency === 'SAR' ? 'ر.س' : currency === 'AED' ? 'د.إ' : currency}` : `${n} ${currency}`;
}
