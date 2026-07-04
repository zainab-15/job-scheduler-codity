import type { FastifyInstance } from 'fastify';
import { findUserByEmail, getOrg, registerUserOrg } from '@scheduler/shared';
import { hashPassword, orgIdOf, verifyCredential } from '../plugins/auth.js';
import { errorEnvelope } from '../plugins/error-handler.js';

export async function registerAuthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: { email: string; password: string; org_name: string } }>(
    '/api/v1/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password', 'org_name'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 10 },
            org_name: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const { email, password, org_name } = req.body;
      const passwordHash = await hashPassword(password);
      const account = await registerUserOrg(fastify.db, { email, passwordHash, orgName: org_name });
      const token = await reply.jwtSign({ sub: account.userId, org_id: account.orgId, email });
      reply.code(201).send({
        token,
        user: { id: account.userId, email },
        organization: { id: account.orgId, name: account.orgName },
      });
    },
  );

  fastify.post<{ Body: { email: string; password: string } }>(
    '/api/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const user = await findUserByEmail(fastify.db, email);
      // verifyCredential runs a full argon2 verify even when the user is
      // missing (against a dummy hash), so a bad email and a bad password
      // cost the same time — no user-enumeration timing oracle (C5).
      const ok = await verifyCredential(user?.password_hash ?? null, password);
      if (!user || !ok) {
        reply.code(401).send(errorEnvelope('INVALID_CREDENTIALS', 'invalid email or password', req.id));
        return;
      }
      const token = await reply.jwtSign({ sub: user.id, org_id: user.org_id, email: user.email });
      reply.send({ token, user: { id: user.id, email: user.email, org_id: user.org_id } });
    },
  );

  fastify.get('/api/v1/auth/me', { preHandler: fastify.authenticate }, async (req, reply) => {
    const orgId = orgIdOf(req);
    const org = await getOrg(fastify.db, orgId);
    reply.send({ user: { id: req.user.sub, email: req.user.email }, organization: org });
  });
}
