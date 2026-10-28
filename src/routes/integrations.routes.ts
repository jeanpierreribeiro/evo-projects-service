import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IntegrationService } from '../services/integration.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { ValidationError, ForbiddenError } from '../errors/app-error.js';

const createPrincipalSchema = z
  .object({
    name: z.string().min(1, 'Nome é obrigatório').max(100),
    description: z.string().max(500).optional(),
  })
  .strict();

const createGrantSchema = z
  .object({
    workspaceId: z.string().min(1, 'workspaceId é obrigatório'),
    projectId: z.string().optional(),
    tools: z.array(z.string()).min(1, 'Ao menos uma ferramenta deve ser concedida'),
    allowedFields: z.array(z.string()).optional(),
    mode: z.enum(['internal', 'customer_support']).optional(),
    canShare: z.boolean().optional(),
    expiresInDays: z.number().int().positive().max(365).optional(),
  })
  .strict();

export async function integrationsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // Hook específico: apenas ADMIN de workspace / operador autorizado pode gerenciar integrações
  fastify.addHook('preHandler', async (request) => {
    const actor = request.actor;
    if (!actor || actor.type !== 'user') {
      throw new ForbiddenError('Apenas usuários autenticados podem gerenciar credenciais de integração.');
    }
  });

  // POST /integrations/principals
  fastify.post(
    '/integrations/principals',
    {
      config: {
        policy: {
          action: 'manage_integrations',
          resource: 'integration',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request, reply) => {
      const parsed = createPrincipalSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const principal = await IntegrationService.createPrincipal(parsed.data);
      return reply.status(201).send({ data: principal });
    }
  );

  // POST /integrations/principals/:id/credentials
  fastify.post(
    '/integrations/principals/:id/credentials',
    {
      config: {
        policy: {
          action: 'manage_integrations',
          resource: 'integration',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as { expiresInDays?: number };

      const credential = await IntegrationService.issueCredential(id, body.expiresInDays);
      return reply.status(201).send({ data: credential });
    }
  );

  // POST /integrations/credentials/:id/revoke
  fastify.post(
    '/integrations/credentials/:id/revoke',
    {
      config: {
        policy: {
          action: 'manage_integrations',
          resource: 'integration',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const revoked = await IntegrationService.revokeCredential(id);
      return { data: { id: revoked.id, revokedAt: revoked.revokedAt } };
    }
  );

  // POST /integrations/principals/:id/grants
  fastify.post(
    '/integrations/principals/:id/grants',
    {
      config: {
        policy: {
          action: 'manage_integrations',
          resource: 'integration',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = createGrantSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const grant = await IntegrationService.createGrant(id, parsed.data);
      return reply.status(201).send({ data: grant });
    }
  );

  // POST /integrations/grants/:id/revoke
  fastify.post(
    '/integrations/grants/:id/revoke',
    {
      config: {
        policy: {
          action: 'manage_integrations',
          resource: 'integration',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const revoked = await IntegrationService.revokeGrant(id);
      return { data: { id: revoked.id, revokedAt: revoked.revokedAt } };
    }
  );
}
