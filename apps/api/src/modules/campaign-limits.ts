/**
 * Campaign limits, one definition used when a message is queued and again, atomically, just before it is sent.
 *
 * Limits (company settings): per contact, at most `perContact7d` campaign messages in any 7 days and at least
 * `minGapHours` between two; per number (connection), at most `daily` campaign messages in any rolling 24 hours.
 *
 * What counts (migration 0034):
 * - only campaign messages; ordinary replies and individually sent templates do not count;
 * - a message counts once, from the moment the sender first hands it to WhatsApp, and keeps counting whatever happens
 *   next (including while a temporary refusal is retried), except when it never reached anyone: WhatsApp refused it
 *   ("rejected"), declined it on every attempt ("exhausted"), or a later check stopped it ("blocked") — 0035;
 * - when queueing, messages already queued but not yet sent are counted too (as if sent now), so a campaign does not
 *   queue more than can go. At send time they are not: each is counted when it goes.
 *
 * The send-time check takes a per-company lock and records the message in the same transaction that moves it to
 * "submitting", so two senders (or two campaigns) cannot both take the last place under a limit.
 */
import type { Tx } from '@conversaflow/database';

export type Limits = { perContact7d: number; minGapHours: number; daily: number };

export async function campaignLimits(tx: Tx): Promise<Limits> {
  const r = (await tx.query<{ a: number | null; b: number | null; c: number | null }>(
    `SELECT campaign_max_per_contact_7d AS a, campaign_min_gap_hours AS b, campaign_daily_limit AS c FROM tenant_settings`)).rows[0];
  return { perContact7d: r?.a ?? 2, minGapHours: r?.b ?? 24, daily: r?.c ?? 250 };
}

/** Campaign messages this number may still start in the current rolling 24 hours (database function, migration 0034). */
export async function dailyRoom(tx: Tx, connectionId: string, lim: Limits, waiting: boolean): Promise<number> {
  const used = (await tx.query<{ n: number }>('SELECT campaign_daily_used($1, $2) AS n', [connectionId, waiting])).rows[0]!.n;
  return Math.max(0, lim.daily - used);
}

export type SendTimeVerdict =
  | { ok: true }
  | { ok: false; reason: 'frequency_limit' }
  | { ok: false; reason: 'daily_limit'; retryAt: Date };

/**
 * The atomic send-time check for one queued campaign message. On success the message is recorded as counted; the
 * caller must move it to "submitting" in the same transaction. A contact over its limits is refused (the message is
 * not sent); a number with no room left holds the message until the oldest counted message leaves the 24-hour window.
 */
export async function claimCampaignSend(tx: Tx, tenantId: string, m: { messageId: string; campaignId: string; conversationId: string },
  testHooks?: { afterCheck?: () => Promise<void> }): Promise<SendTimeVerdict> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:campaign-limits`]);
  // Already counted at an earlier hand-over that WhatsApp temporarily declined: it keeps its place while it is retried,
  // and is not checked against its own count (final recheck, finding P2-1).
  if ((await tx.query('SELECT 1 FROM campaign_send_counts WHERE message_id = $1', [m.messageId])).rowCount) return { ok: true };
  const lim = await campaignLimits(tx);
  const conv = (await tx.query<{ contact_id: string; connection_id: string }>(
    'SELECT contact_id, connection_id FROM conversations WHERE id = $1', [m.conversationId])).rows[0]!;
  const blocked = (await tx.query<{ b: boolean }>('SELECT campaign_contact_blocked($1, $2, $3, false) AS b',
    [conv.contact_id, lim.perContact7d, lim.minGapHours])).rows[0]!.b;
  if (blocked) return { ok: false, reason: 'frequency_limit' };
  if ((await dailyRoom(tx, conv.connection_id, lim, false)) <= 0) {
    // Room frees up when the oldest counted message in the window turns 24 hours old (at least a minute from now).
    const at = (await tx.query<{ at: Date }>('SELECT campaign_daily_room_at($1) AS at', [conv.connection_id])).rows[0]!.at;
    return { ok: false, reason: 'daily_limit', retryAt: at };
  }
  // Tests only: hold here, after the check and before the count is recorded, to prove the lock makes the pair atomic.
  if (testHooks?.afterCheck) await testHooks.afterCheck();
  await tx.query(
    `INSERT INTO campaign_send_counts (tenant_id, message_id, campaign_id, connection_id, contact_id) VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, m.messageId, m.campaignId, conv.connection_id, conv.contact_id]);
  return { ok: true };
}
