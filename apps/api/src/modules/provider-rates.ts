import type { Tx } from '@conversaflow/database';

export interface ProviderRate {
  market: string;
  category: string;
  unit: string;
  currency: string;
  rate: number;
  effectiveFrom: string;
  sourceUrl: string;
}

/**
 * Meta (provider) rates are dated configuration. Only VERIFIED rows — reconciled against Meta's official
 * documentation — may be used for anything a customer sees. Drafts are for internal review only.
 */
export async function providerRateOn(
  tx: Tx, q: { market: string; category: string; currency: string; on: string; includeDrafts?: boolean },
): Promise<ProviderRate | null> {
  const { rows } = await tx.query(
    `SELECT market, category, unit, currency, rate::float8 AS rate, effective_from::text AS "effectiveFrom", source_url AS "sourceUrl"
     FROM provider_rates
     WHERE provider = 'meta_whatsapp' AND market = $1 AND category = $2 AND currency = $3
       AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to > $4::date)
       AND (status = 'verified' OR $5::boolean)
     ORDER BY (status = 'verified') DESC, effective_from DESC LIMIT 1`,
    [q.market, q.category, q.currency, q.on, q.includeDrafts ?? false]);
  return (rows[0] as ProviderRate | undefined) ?? null;
}
