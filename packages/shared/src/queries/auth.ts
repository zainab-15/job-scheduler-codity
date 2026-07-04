import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  // random suffix so slug collisions across orgs are effectively impossible
  // without needing a retry loop (UNIQUE(slug) is still the real guarantee)
  return `${base || 'org'}-${randomUUID().slice(0, 8)}`;
}

export interface RegisteredAccount {
  userId: string;
  orgId: string;
  orgName: string;
}

/**
 * Register creates an org + its first user in one tx — satisfies
 * "Organizations" without building an invite/RBAC system (out of scope).
 * The caller (routes/auth.ts) hashes the password with argon2id before
 * calling this; this module never sees a plaintext password.
 */
export async function registerUserOrg(
  db: Kysely<Database>,
  args: { email: string; passwordHash: string; orgName: string },
): Promise<RegisteredAccount> {
  return db.transaction().execute(async (trx) => {
    const org = await trx
      .insertInto('organizations')
      .values({ name: args.orgName, slug: slugify(args.orgName) })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
    const user = await trx
      .insertInto('users')
      .values({ org_id: org.id, email: args.email, password_hash: args.passwordHash })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { userId: user.id, orgId: org.id, orgName: org.name };
  });
}

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  password_hash: string;
}

export async function findUserByEmail(db: Kysely<Database>, email: string): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
}

export async function getOrg(db: Kysely<Database>, orgId: string): Promise<OrgRow | undefined> {
  return db
    .selectFrom('organizations')
    .select(['id', 'name', 'slug', 'created_at'])
    .where('id', '=', orgId)
    .executeTakeFirst();
}

export async function renameOrg(db: Kysely<Database>, orgId: string, name: string): Promise<OrgRow | undefined> {
  return db
    .updateTable('organizations')
    .set({ name })
    .where('id', '=', orgId)
    .returning(['id', 'name', 'slug', 'created_at'])
    .executeTakeFirst();
}
