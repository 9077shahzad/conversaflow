import { withContext, type Db } from '@conversaflow/database';
import type { TenantActor } from '../core/context';
import { AuditService } from './audit.service';
import { parseWebhook, type ParsedEvent, type Provider } from './channels';
import { applyStatus } from './sender';
import { applyTemplateEvent } from './templates.service';
import { lockAssignmentIfOn } from './auto-assign';
import { applyInboundMessage } from './inbox.service';

/**
 * Incoming webhook events, recorded by the request and applied by the worker (AX-3).
 *
 *  1. The webhook request checks the signature (controller), splits the delivery into events, finds each event's
 *     company through the reviewed routing lookups and records it. A repeat of an event already recorded changes
 *     nothing (unique key). The request then answers WhatsApp; it does no other work.
 *  2. The worker leases waiting events (`inbound_claim`, which sees scheduling columns only) and applies them per
 *     company and number, oldest first, with the same locks in the same order as before (assignment lock, then each
 *     customer's lock in ascending number order). Applying and marking the event as processed are one transaction,
 *     so an event is applied at most once even if two workers race or a lease expires mid-way.
 *  3. A failure is retried with back-off. After `maxAttempts` the event is marked failed and shown on the channel
 *     health page, where someone with `channels.manage` can ask for it to be tried again.
 *
 * `INBOUND_APPLY=request` applies the recorded events in the same request, through the same code, after recording
 * them. It exists for development and the test suite; production refuses it.
 */
export const INBOUND_LIMITS = {
  leaseSeconds: 120,
  maxAttempts: 8,
  /** Seconds to wait after the 1st, 2nd, ... failed attempt. */
  backoffSeconds: [5, 30, 120, 600, 1800, 3600, 7200],
};

export interface Claimed { event_id: string; tenant_id: string; connection_id: string | null; account_ref: string | null }
export interface InboundCounts { applied: number; duplicate: number; stale: number; orphan: number; unrouted: number; unknownTemplate: number; skipped: number; queued: number; retrying: number; failed: number }
const zero = (): InboundCounts => ({ applied: 0, duplicate: 0, stale: 0, orphan: 0, unrouted: 0, unknownTemplate: 0, skipped: 0, queued: 0, retrying: 0, failed: 0 });

/** The parsed event without its raw part (which is stored separately), as stored in `parsed`. */
function toStored(e: ParsedEvent): string {
  return JSON.stringify({ ...e, raw: undefined });
}
function fromStored(parsed: Record<string, unknown>): ParsedEvent {
  return { ...parsed, occurredAt: new Date(String(parsed.occurredAt)), raw: null } as unknown as ParsedEvent;
}

/**
 * Records the events of one verified delivery. With `lease`, the recorded events are leased to the caller so a
 * worker does not pick them up while the request applies them (request mode); if the request dies, the lease runs
 * out and a worker applies them.
 */
export async function recordWebhook(db: Db, provider: Provider, payload: unknown, lease: boolean): Promise<{ counts: InboundCounts; recorded: Claimed[] }> {
  const { events, skipped } = parseWebhook(payload);
  const counts = { ...zero(), skipped };
  const recorded: Claimed[] = [];
  const byNumber = new Map<string, ParsedEvent[]>();
  const byAccount = new Map<string, ParsedEvent[]>();
  for (const e of events) {
    if (e.kind === 'template') byAccount.set(e.accountId, [...(byAccount.get(e.accountId) ?? []), e]);
    else byNumber.set(e.providerNumberId, [...(byNumber.get(e.providerNumberId) ?? []), e]);
  }
  const leaseSecs = lease ? INBOUND_LIMITS.leaseSeconds : 0;
  for (const [account, list] of byAccount) {
    const route = await withContext(db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ tenant_id: string; account_ref: string }>('SELECT * FROM account_route($1, $2)', [provider, account])).rows[0]);
    if (!route) { counts.unrouted += list.length; continue; }
    await withContext(db, { tenantId: route.tenant_id, userId: null }, async (tx) => {
      for (const e of list) {
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO webhook_events (tenant_id, account_ref, event_key, kind, payload, parsed, lease_until)
           VALUES ($1, $2, $3, 'template', $4, $5, CASE WHEN $6::int > 0 THEN now() + make_interval(secs => $6::int) END)
           ON CONFLICT (tenant_id, account_ref, event_key) WHERE account_ref IS NOT NULL DO NOTHING RETURNING id`,
          [route.tenant_id, route.account_ref, e.key, JSON.stringify(e.raw), toStored(e), leaseSecs]);
        if (!ins.rows[0]) { counts.duplicate++; continue; }
        recorded.push({ event_id: ins.rows[0].id, tenant_id: route.tenant_id, connection_id: null, account_ref: route.account_ref });
      }
    });
  }
  for (const [number, list] of byNumber) {
    const route = await withContext(db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ tenant_id: string; connection_id: string }>('SELECT * FROM channel_route($1, $2)', [provider, number])).rows[0]);
    if (!route) { counts.unrouted += list.length; continue; }
    await withContext(db, { tenantId: route.tenant_id, userId: null }, async (tx) => {
      for (const e of list) {
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO webhook_events (tenant_id, connection_id, event_key, kind, payload, parsed, lease_until)
           VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int > 0 THEN now() + make_interval(secs => $7::int) END)
           ON CONFLICT (tenant_id, connection_id, event_key) DO NOTHING RETURNING id`,
          [route.tenant_id, route.connection_id, e.key, e.kind, JSON.stringify(e.raw), toStored(e), leaseSecs]);
        if (!ins.rows[0]) { counts.duplicate++; continue; }
        recorded.push({ event_id: ins.rows[0].id, tenant_id: route.tenant_id, connection_id: route.connection_id, account_ref: null });
      }
    });
  }
  counts.queued = recorded.length;
  return { counts, recorded };
}

export class InboundProcessor {
  /** faults: test hook, called inside the applying transaction before anything is marked processed (never set in production). */
  constructor(private readonly db: Db, private readonly faults: { beforeMark?: (eventIds: string[]) => Promise<void> | void } = {}) {}

  /** Worker: leases waiting events across companies and applies them. Returns how many were leased. */
  async dispatchDue(limit = 200): Promise<number> {
    const claimed = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<Claimed>('SELECT * FROM inbound_claim($1, $2)', [limit, INBOUND_LIMITS.leaseSeconds])).rows);
    if (claimed.length) await this.process(claimed);
    return claimed.length;
  }

  /** Applies the given recorded events, grouped by company and by number (or business account). */
  async process(events: Claimed[]): Promise<InboundCounts> {
    const counts = zero();
    const groups = new Map<string, Claimed[]>();
    for (const e of events) {
      const k = `${e.tenant_id}|${e.connection_id ?? `a:${e.account_ref}`}`;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const unsorted of groups.values()) {
      // Event ids are time-ordered (v7): the order the events were recorded in (review of AX-3, L4).
      const list = [...unsorted].sort((a, b) => a.event_id.localeCompare(b.event_id));
      const tenant = list[0]!.tenant_id;
      try {
        add(counts, await this.applyGroup(tenant, list.map((e) => e.event_id)));
      } catch {
        // One bad event must not hold up the others: apply them one by one, and retry only the one that fails.
        for (const e of list) {
          try { add(counts, await this.applyGroup(tenant, [e.event_id])); } catch (err) {
            const gaveUp = await this.later(tenant, e.event_id, err);
            if (gaveUp) counts.failed++; else counts.retrying++;
          }
        }
      }
    }
    return counts;
  }

  private async applyGroup(tenantId: string, ids: string[]): Promise<InboundCounts> {
    return withContext(this.db, { tenantId, userId: null }, async (tx) => {
      const counts = zero();
      // A lock held elsewhere (for example a large contact import) is not waited for indefinitely: after a few seconds
      // this attempt fails and is retried later, and other companies' events carry on (review of AX-3, L1).
      await tx.query(`SET LOCAL lock_timeout = '5s'`);
      // Locked and checked here: whoever gets the rows first applies them; anyone else finds them processed.
      const rows = (await tx.query<{ id: string; connection_id: string | null; account_ref: string | null; parsed: Record<string, unknown> | null }>(
        `SELECT id, connection_id, account_ref, parsed FROM webhook_events
         WHERE id = ANY($1::uuid[]) AND processed_at IS NULL AND failed_at IS NULL ORDER BY id FOR UPDATE`, [ids])).rows;
      if (rows.length === 0) return counts;
      // An event recorded without its parsed form (none should exist) cannot be applied: it is marked failed at once
      // rather than leased again forever (review of AX-3, L2).
      const unparsed = rows.filter((r) => !r.parsed).map((r) => r.id);
      if (unparsed.length) {
        await tx.query(`UPDATE webhook_events SET failed_at = now(), last_error = 'unparsed', lease_until = NULL WHERE id = ANY($1::uuid[])`, [unparsed]);
        counts.failed += unparsed.length;
      }
      const items = rows.filter((r) => r.parsed).map((r) => ({ row: r, e: fromStored(r.parsed!) }));
      if (items.length === 0) return counts;
      // Oldest first, so a delivery that bundles several events applies them in the provider's order.
      items.sort((a, b) => a.e.occurredAt.getTime() - b.e.occurredAt.getTime() || a.row.id.localeCompare(b.row.id));
      const results: Array<{ id: string; outcome: string }> = [];
      const accountRef = rows[0]!.account_ref;
      if (accountRef) {
        for (const { row, e } of items) {
          const outcome = await applyTemplateEvent(tx, accountRef, e as Extract<ParsedEvent, { kind: 'template' }>);
          results.push({ id: row.id, outcome });
        }
      } else {
        const connectionId = rows[0]!.connection_id!;
        // Lock order, the same in every transaction: the company's assignment lock (when assignment is on), then each
        // customer's lock in ascending number order, as contact imports do (slice 5 review M1, L3).
        const messages = items.map((i) => i.e).filter((e): e is Extract<ParsedEvent, { kind: 'message' }> => e.kind === 'message');
        const assignmentLocked = messages.length ? await lockAssignmentIfOn(tx, tenantId) : false;
        for (const from of [...new Set(messages.map((e) => e.from))].sort()) {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:wa:${from}`]);
        }
        for (const { row, e } of items) {
          const outcome = e.kind === 'message'
            ? await applyInboundMessage(tx, tenantId, connectionId, e, assignmentLocked)
            : e.kind === 'status' ? await applyStatus(tx, e.providerMessageId, e.status, e.errorCode, e.callbackData) : 'applied';
          results.push({ id: row.id, outcome });
        }
      }
      await this.faults.beforeMark?.(results.map((r) => r.id));
      for (const r of results) {
        await tx.query('UPDATE webhook_events SET processed_at = now(), outcome = $2, lease_until = NULL WHERE id = $1', [r.id, r.outcome]);
        if (r.outcome === 'applied') counts.applied++;
        else if (r.outcome === 'stale_status' || r.outcome === 'stale_template') counts.stale++;
        else if (r.outcome === 'unknown_template') counts.unknownTemplate++;
        else counts.orphan++;
      }
      return counts;
    });
  }

  /** Records a failed attempt. Returns true when the event has now been given up on. */
  private async later(tenantId: string, id: string, err: unknown): Promise<boolean> {
    const code = String((err as { code?: unknown })?.code ?? (err instanceof Error ? err.name : 'error')).slice(0, 120);
    return withContext(this.db, { tenantId, userId: null }, async (tx) => {
      const r = (await tx.query<{ failed: boolean }>(
        `UPDATE webhook_events SET attempts = attempts + 1, last_error = $2, lease_until = NULL,
                next_attempt_at = now() + make_interval(secs => ($3::int[])[least(attempts + 1, array_length($3::int[], 1))]),
                failed_at = CASE WHEN attempts + 1 >= $4 THEN now() END
         WHERE id = $1 AND processed_at IS NULL RETURNING failed_at IS NOT NULL AS failed`,
        [id, code, INBOUND_LIMITS.backoffSeconds, INBOUND_LIMITS.maxAttempts])).rows[0];
      return r?.failed ?? false;
    });
  }

  /** Channel health recovery: events the worker gave up on are tried again from the start. Audited. */
  static async retryFailed(db: Db, actor: TenantActor): Promise<{ requeued: number }> {
    return withContext(db, actor, async (tx) => {
      const n = (await tx.query(
        `UPDATE webhook_events SET failed_at = NULL, attempts = 0, next_attempt_at = now(), lease_until = NULL
         WHERE failed_at IS NOT NULL`)).rowCount ?? 0;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'channel.inbound_retried', ip: actor.ip,
        targetType: 'tenant', targetId: actor.tenantId, metadata: { requeued: n } });
      return { requeued: n };
    });
  }
}

function add(into: InboundCounts, from: InboundCounts) {
  for (const k of Object.keys(into) as Array<keyof InboundCounts>) into[k] += from[k];
}

