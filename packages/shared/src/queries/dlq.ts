import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/types.js';
import type { PaginatedResult } from './projects.js';
import { retryJob } from './jobs.js';

export interface DlqRow {
  id: string;
  job_id: string | null;
  queue_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  death_reason: string;
  final_error: string | null;
  died_at: Date;
}

export async function listDlqByQueue(
  db: Kysely<Database>,
  args: { orgId: string; queueId: string; limit: number; offset: number },
): Promise<PaginatedResult<DlqRow> | 'queue_not_found'> {
  const queue = await sql<{ id: string }>`
    SELECT q.id FROM queues q JOIN projects p ON p.id = q.project_id
    WHERE q.id = ${args.queueId} AND p.org_id = ${args.orgId}
  `.execute(db);
  if (queue.rows.length === 0) return 'queue_not_found';

  const res = await sql<DlqRow & { total: string }>`
    SELECT d.*, count(*) OVER()::int AS total
    FROM dead_letter_jobs d
    WHERE d.queue_id = ${args.queueId}
    ORDER BY d.died_at DESC
    LIMIT ${args.limit} OFFSET ${args.offset}
  `.execute(db);
  const total = res.rows.length > 0 ? Number(res.rows[0]!.total) : 0;
  return { data: res.rows, total, limit: args.limit, offset: args.offset };
}

export async function listDlqByProject(
  db: Kysely<Database>,
  args: { orgId: string; projectId: string; limit: number; offset: number },
): Promise<PaginatedResult<DlqRow> | 'project_not_found'> {
  const project = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', args.projectId)
    .where('org_id', '=', args.orgId)
    .executeTakeFirst();
  if (!project) return 'project_not_found';

  const res = await sql<DlqRow & { total: string }>`
    SELECT d.*, count(*) OVER()::int AS total
    FROM dead_letter_jobs d
    WHERE d.queue_id IN (SELECT id FROM queues WHERE project_id = ${args.projectId})
    ORDER BY d.died_at DESC
    LIMIT ${args.limit} OFFSET ${args.offset}
  `.execute(db);
  const total = res.rows.length > 0 ? Number(res.rows[0]!.total) : 0;
  return { data: res.rows, total, limit: args.limit, offset: args.offset };
}

export type DlqRequeueResult = 'requeued' | 'not_found' | 'origin_deleted';

/**
 * `job_id IS NULL` rows are discard-only (409 ORIGIN_DELETED), not
 * reconstructed: no Day-2 route deletes an individual job (only queue-delete
 * cascades, which also cascades the DLQ row itself via queue_id), so this
 * path only exists as a schema-level safety net for a future retention/TTL
 * job-cleanup feature — building reconstruction now would be scope creep for
 * a path nothing currently reaches. Otherwise this is a thin wrapper over
 * retryJob (DRY — same one-tx state transition), keyed by DLQ id.
 */
export async function requeueDlq(db: Kysely<Database>, args: { orgId: string; dlqId: string }): Promise<DlqRequeueResult> {
  const dlq = await sql<{ id: string; job_id: string | null }>`
    SELECT d.id, d.job_id
    FROM dead_letter_jobs d JOIN queues q ON q.id = d.queue_id JOIN projects p ON p.id = q.project_id
    WHERE d.id = ${args.dlqId} AND p.org_id = ${args.orgId}
  `.execute(db);
  const row = dlq.rows[0];
  if (!row) return 'not_found';
  if (!row.job_id) return 'origin_deleted';

  const result = await retryJob(db, { orgId: args.orgId, jobId: row.job_id });
  if (result === 'retried') return 'requeued';
  // race: the underlying job was already handled by another request between
  // our SELECT and the retryJob call — treat as a stale reference
  return 'not_found';
}

export type DlqDiscardResult = 'discarded' | 'not_found';

/** Removes the DLQ worklist entry only; the underlying `jobs` row (status
 *  still 'dead') is untouched — discard means "reviewed, stop showing me
 *  this," not "erase the record." */
export async function discardDlq(db: Kysely<Database>, args: { orgId: string; dlqId: string }): Promise<DlqDiscardResult> {
  const res = await sql<{ id: string }>`
    DELETE FROM dead_letter_jobs d
    USING queues q, projects p
    WHERE d.id = ${args.dlqId} AND d.queue_id = q.id AND q.project_id = p.id AND p.org_id = ${args.orgId}
    RETURNING d.id
  `.execute(db);
  return res.rows.length > 0 ? 'discarded' : 'not_found';
}
