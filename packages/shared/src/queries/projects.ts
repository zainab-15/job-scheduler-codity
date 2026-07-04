import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/types.js';

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'project'
  );
}

export async function createProject(
  db: Kysely<Database>,
  args: { orgId: string; name: string; description?: string | null },
): Promise<ProjectRow> {
  return db
    .insertInto('projects')
    .values({ org_id: args.orgId, name: args.name, slug: slugify(args.name), description: args.description ?? null })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listProjects(
  db: Kysely<Database>,
  args: { orgId: string; limit: number; offset: number },
): Promise<PaginatedResult<ProjectRow & { queue_count: number }>> {
  const res = await sql<ProjectRow & { queue_count: string; total: string }>`
    SELECT p.*,
           (SELECT count(*) FROM queues q WHERE q.project_id = p.id)::int AS queue_count,
           count(*) OVER()::int AS total
    FROM projects p
    WHERE p.org_id = ${args.orgId}
    ORDER BY p.created_at DESC
    LIMIT ${args.limit} OFFSET ${args.offset}
  `.execute(db);
  const total = res.rows.length > 0 ? Number(res.rows[0]!.total) : 0;
  return {
    data: res.rows.map((r) => ({ ...r, queue_count: Number(r.queue_count) })),
    total,
    limit: args.limit,
    offset: args.offset,
  };
}

export async function getProject(
  db: Kysely<Database>,
  args: { orgId: string; projectId: string },
): Promise<(ProjectRow & { queue_count: number }) | undefined> {
  const res = await sql<ProjectRow & { queue_count: string }>`
    SELECT p.*, (SELECT count(*) FROM queues q WHERE q.project_id = p.id)::int AS queue_count
    FROM projects p
    WHERE p.id = ${args.projectId} AND p.org_id = ${args.orgId}
  `.execute(db);
  const row = res.rows[0];
  return row ? { ...row, queue_count: Number(row.queue_count) } : undefined;
}

export async function updateProject(
  db: Kysely<Database>,
  args: { orgId: string; projectId: string; name?: string; description?: string | null },
): Promise<ProjectRow | undefined> {
  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.description !== undefined) patch.description = args.description;
  if (Object.keys(patch).length === 0) {
    return db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', args.projectId)
      .where('org_id', '=', args.orgId)
      .executeTakeFirst();
  }
  return db
    .updateTable('projects')
    .set(patch)
    .where('id', '=', args.projectId)
    .where('org_id', '=', args.orgId)
    .returningAll()
    .executeTakeFirst();
}

export type DeleteResult = 'deleted' | 'not_found' | 'has_running_jobs';

/**
 * Single-statement guarded delete (R11 fix): the running-jobs check and the
 * delete happen in ONE atomic DELETE ... WHERE NOT EXISTS(...), so a job
 * cannot start running in the gap between "check" and "delete" the way a
 * separate SELECT-then-DELETE would allow.
 */
export async function deleteProject(db: Kysely<Database>, args: { orgId: string; projectId: string }): Promise<DeleteResult> {
  const del = await sql<{ id: string }>`
    DELETE FROM projects p
    WHERE p.id = ${args.projectId} AND p.org_id = ${args.orgId}
      AND NOT EXISTS (
        SELECT 1 FROM jobs j JOIN queues q ON q.id = j.queue_id
        WHERE q.project_id = p.id AND j.status = 'running'
      )
    RETURNING p.id
  `.execute(db);
  if (del.rows.length > 0) return 'deleted';

  // 0 rows: either not found, or blocked by running jobs — this read-only
  // disambiguation does NOT reintroduce the race; the atomic decision above
  // already happened, this only picks which error code to report.
  const exists = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', args.projectId)
    .where('org_id', '=', args.orgId)
    .executeTakeFirst();
  return exists ? 'has_running_jobs' : 'not_found';
}
