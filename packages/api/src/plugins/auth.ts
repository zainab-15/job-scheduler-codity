import argon2 from 'argon2';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope } from './error-handler.js';

export interface JwtClaims {
  sub: string; // user id
  org_id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtClaims;
    user: JwtClaims;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // a malformed/foreign hash format is a verification failure, not a crash
  }
}

// A valid argon2id hash of a throwaway string. Used ONLY to burn the same
// argon2 cost on the login path when the email doesn't exist, so "no such
// user" and "wrong password" take the same time (C5 — closes the timing
// side-channel that would otherwise let an attacker enumerate valid emails).
const DUMMY_ARGON2_HASH = '$argon2id$v=19$m=65536,t=3,p=4$8/H/PzSeG+/LckrNj7IGjA$q3+JNZGZpeVg+cSDK2ZupliP38LGZCr3v8spKOYrYv0';

/**
 * Constant-time-ish credential check: when `hash` is null (no such user), still
 * runs a full argon2 verify against a dummy hash so the response time doesn't
 * reveal whether the email exists. Always returns false for a null hash.
 */
export async function verifyCredential(hash: string | null, password: string): Promise<boolean> {
  if (hash === null) {
    await verifyPassword(DUMMY_ARGON2_HASH, password); // burn equal time, discard result
    return false;
  }
  return verifyPassword(hash, password);
}

/**
 * Registers @fastify/jwt (a genuine third-party plugin — safe to
 * `fastify.register()`), then adds the `authenticate` preHandler at the
 * root level. R30: `algorithms: ['HS256']` is pinned on verify so a token
 * signed with `alg: none` or a different algorithm is rejected outright.
 */
export async function registerAuth(fastify: FastifyInstance, jwtSecret: string): Promise<void> {
  await fastify.register(fastifyJwt, {
    secret: jwtSecret,
    sign: { expiresIn: '12h' },
    verify: { algorithms: ['HS256'] },
  });

  fastify.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send(errorEnvelope('UNAUTHORIZED', 'missing or invalid token', req.id));
    }
  });
}

/** Every org-scoped route reads this, never a client-supplied org id — the
 *  claim is the only source of truth for "which org am I." */
export function orgIdOf(req: FastifyRequest): string {
  return (req.user as JwtClaims).org_id;
}
