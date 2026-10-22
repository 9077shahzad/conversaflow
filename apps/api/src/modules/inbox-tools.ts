import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';

/**
 * Tags and saved replies (BRD v1.2 Wave 1, CF-EXT-002, migration 0037).
 *
 * - Tags are the company's own labels. Supervisors and above manage the list (`tags.manage`); anyone who can reply in a
 *   conversation (`inbox.reply`, and the conversation is visible to them) can put a tag on it or take it off.
 * - Saved replies are shared texts. `saved_replies.manage` edits the list; anyone with `inbox.reply` can read it and
 *   insert one into the reply box. Inserting never sends: the agent edits and sends as usual, with every send check.
 */
export const TAG_COLORS = ['slate', 'teal', 'green', 'amber', 'red', 'violet', 'blue'] as const;
const singleLine = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\r\n\t]/.test(v), 'Use one line.');
const TagInput = z.object({ name: singleLine(40), color: z.enum(TAG_COLORS).default('slate') });
const TagUpdate = z.object({ name: singleLine(40).optional(), color: z.enum(TAG_COLORS).optional() })
  .refine((v) => v.name !== undefined || v.color !== undefined, 'Nothing to change.');
const ReplyInput = z.object({ title: singleLine(80), body: z.string().trim().min(1).max(4096), language: z.enum(['en', 'ar']).nullable().default(null) });
const ReplyUpdate = z.object({ title: singleLine(80).optional(), body: z.string().trim().min(1).max(4096).optional(), language: z.enum(['en', 'ar']).nullable().optional() })
  .refine((v) => v.title !== undefined || v.body !== undefined || v.language !== undefined, 'Nothing to change.');
const TAG_COLUMNS = `id, name, color, created_at AS "createdAt"`;
const REPLY_COLUMNS = `id, title, body, language, updated_at AS "updatedAt"`;

/** Unique-name violations become a plain message instead of a server error. */
function duplicateName(err: unknown, what: string): never {
  if ((err as { code?: string }).code === '23505') throw Errors.conflict('name_taken', `A ${what} with this name already exists.`);
  throw err;
}

export class TagsService {
  constructor(private readonly deps: Deps) {}

  list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) =>
      (await tx.query(`SELECT ${TAG_COLUMNS}, (SELECT count(*)::int FROM conversation_tags ct WHERE ct.tag_id = t.id) AS "uses"
                       FROM tags t ORDER BY lower(name)`)).rows);
  }

  async create(actor: TenantActor, input: unknown) {
    const body = parse(TagInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const count = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM tags')).rows[0]!.n;
      if (count >= 200) throw Errors.conflict('tag_limit', 'A company can have up to 200 tags.');
      const row = await tx.query(`INSERT INTO tags (tenant_id, name, color, created_by) VALUES ($1, $2, $3, $4) RETURNING ${TAG_COLUMNS}`,
        [actor.tenantId, body.name, body.color, actor.membershipId]).catch((e) => duplicateName(e, 'tag'));
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'tag.created', ip: actor.ip,
        targetType: 'tag', targetId: row.rows[0].id, metadata: { name: body.name } });
      return row.rows[0];
    });
  }

  async update(actor: TenantActor, id: string, input: unknown) {
    const body = parse(TagUpdate, input);
    if (!isUuid(id)) throw Errors.notFound('Tag');
    return withContext(this.deps.db, actor, async (tx) => {
      const row = (await tx.query(`UPDATE tags SET name = coalesce($2, name), color = coalesce($3, color) WHERE id = $1 RETURNING ${TAG_COLUMNS}`,
        [id, body.name ?? null, body.color ?? null]).catch((e) => duplicateName(e, 'tag'))).rows[0];
      if (!row) throw Errors.notFound('Tag');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'tag.updated', ip: actor.ip,
        targetType: 'tag', targetId: id, metadata: { name: row.name, color: row.color } });
      return row;
    });
  }

  async remove(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Tag');
    await withContext(this.deps.db, actor, async (tx) => {
      const row = (await tx.query<{ name: string }>('DELETE FROM tags WHERE id = $1 RETURNING name', [id])).rows[0];
      if (!row) throw Errors.notFound('Tag');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'tag.deleted', ip: actor.ip,
        targetType: 'tag', targetId: id, metadata: { name: row.name } });
    });
  }

  /** Puts a tag on a conversation the person can see. Repeating it changes nothing. */
  async tagConversation(actor: TenantActor, conversationId: string, tagId: string, on: boolean) {
    if (!isUuid(conversationId)) throw Errors.notFound('Conversation');
    if (!isUuid(tagId)) throw Errors.notFound('Tag');
    return withContext(this.deps.db, actor, async (tx) => {
      await visibleConversation(tx, actor, conversationId);
      const tag = (await tx.query<{ name: string }>('SELECT name FROM tags WHERE id = $1', [tagId])).rows[0];
      if (!tag) throw Errors.notFound('Tag');
      const changed = on
        ? (await tx.query(`INSERT INTO conversation_tags (tenant_id, conversation_id, tag_id, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [actor.tenantId, conversationId, tagId, actor.membershipId])).rowCount
        : (await tx.query('DELETE FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2', [conversationId, tagId])).rowCount;
      if (changed) {
        await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, $3, $4, $5)`,
          [actor.tenantId, conversationId, on ? 'tagged' : 'untagged', actor.membershipId, JSON.stringify({ tagId, name: tag.name })]);
      }
      return conversationTags(tx, conversationId);
    });
  }
}

export class SavedRepliesService {
  constructor(private readonly deps: Deps) {}

  list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(`SELECT ${REPLY_COLUMNS} FROM saved_replies ORDER BY lower(title)`)).rows);
  }

  async create(actor: TenantActor, input: unknown) {
    const body = parse(ReplyInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const count = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM saved_replies')).rows[0]!.n;
      if (count >= 500) throw Errors.conflict('saved_reply_limit', 'A company can have up to 500 saved replies.');
      const row = (await tx.query(`INSERT INTO saved_replies (tenant_id, title, body, language, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING ${REPLY_COLUMNS}`,
        [actor.tenantId, body.title, body.body, body.language, actor.membershipId]).catch((e) => duplicateName(e, 'saved reply'))).rows[0];
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'saved_reply.created', ip: actor.ip,
        targetType: 'saved_reply', targetId: row.id, metadata: { title: body.title } });
      return row;
    });
  }

  async update(actor: TenantActor, id: string, input: unknown) {
    const body = parse(ReplyUpdate, input);
    if (!isUuid(id)) throw Errors.notFound('Saved reply');
    return withContext(this.deps.db, actor, async (tx) => {
      const row = (await tx.query(
        `UPDATE saved_replies SET title = coalesce($2, title), body = coalesce($3, body),
           language = CASE WHEN $5 THEN $4 ELSE language END, updated_by = $6, updated_at = now() WHERE id = $1 RETURNING ${REPLY_COLUMNS}`,
        [id, body.title ?? null, body.body ?? null, body.language ?? null, body.language !== undefined, actor.membershipId])
        .catch((e) => duplicateName(e, 'saved reply'))).rows[0];
      if (!row) throw Errors.notFound('Saved reply');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'saved_reply.updated', ip: actor.ip,
        targetType: 'saved_reply', targetId: id, metadata: { title: row.title } });
      return row;
    });
  }

  async remove(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Saved reply');
    await withContext(this.deps.db, actor, async (tx) => {
      const row = (await tx.query<{ title: string }>('DELETE FROM saved_replies WHERE id = $1 RETURNING title', [id])).rows[0];
      if (!row) throw Errors.notFound('Saved reply');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'saved_reply.deleted', ip: actor.ip,
        targetType: 'saved_reply', targetId: id, metadata: { title: row.title } });
    });
  }
}

/** The same visibility rule as the inbox: everything with `inbox.read_all`, otherwise unassigned or your own. */
async function visibleConversation(tx: Tx, actor: TenantActor, id: string) {
  const row = (await tx.query('SELECT id FROM conversations WHERE id = $1 AND ($2::boolean OR assigned_membership_id IS NULL OR assigned_membership_id = $3::uuid)',
    [id, actor.permissions.has('inbox.read_all'), actor.membershipId])).rows[0];
  if (!row) throw Errors.notFound('Conversation');
}

export async function conversationTags(tx: Tx, conversationId: string) {
  return (await tx.query(`SELECT t.id, t.name, t.color FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id
                          WHERE ct.conversation_id = $1 ORDER BY lower(t.name)`, [conversationId])).rows;
}

