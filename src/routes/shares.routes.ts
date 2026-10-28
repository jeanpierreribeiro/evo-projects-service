import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ShareService } from '../services/share.service.js';
import { AccessService } from '../services/access.service.js';
import { IdempotencyService } from '../services/idempotency.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { config } from '../config/env.js';
import { ForbiddenError, ValidationError } from '../errors/app-error.js';

const createShareSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
  showDescription: z.boolean().optional(),
  showSubtasks: z.boolean().optional(),
  showResources: z.boolean().optional(),
  selectedResourceIds: z.array(z.string()).optional(),
});

const patchShareSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
  showDescription: z.boolean().optional(),
  showSubtasks: z.boolean().optional(),
  showResources: z.boolean().optional(),
  selectedResourceIds: z.array(z.string()).optional(),
  expectedVersion: z.number().int().optional(),
});

export async function shareRoutes(fastify: FastifyInstance) {
  // Middleware de autorização prévia
  fastify.addHook('preHandler', authMiddleware);

  // Hook para verificar a feature flag PROJECTS_SHARING_ENABLED
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    if (!config.projectsSharingEnabled) {
      throw new ForbiddenError(
        'O recurso de compartilhamento público está desabilitado nesta instância (PROJECTS_SHARING_ENABLED=false).',
        'FEATURE_DISABLED'
      );
    }
  });

  // POST /tasks/:taskId/shares/preview - Prévia do conteúdo público
  fastify.post(
    '/tasks/:taskId/shares/preview',
    {
      config: {
        policy: {
          action: 'preview',
          resource: 'shares',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { taskId: string }; Body: unknown }>, reply: FastifyReply) => {
      const parsed = createShareSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Parâmetros de prévia inválidos', parsed.error.format());
      }

      const preview = await ShareService.previewShare(request.actor!, request.params.taskId, parsed.data);
      return reply.send(preview);
    }
  );

  // POST /tasks/:taskId/shares - Emite novo link com token e PIN
  fastify.post(
    '/tasks/:taskId/shares',
    {
      config: {
        policy: {
          action: 'create',
          resource: 'shares',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { taskId: string }; Body: unknown; Headers: { 'idempotency-key'?: string } }>,
      reply: FastifyReply
    ) => {
      const parsed = createShareSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Parâmetros de compartilhamento inválidos', parsed.error.format());
      }

      const idempotencyHeader = request.headers['idempotency-key'] as string | undefined;
      const task = await AccessService.getAuthorizedTask(request.params.taskId, request.actor!, 'read_task');
      const scopeKey = IdempotencyService.buildScopeKey(
        request.actor!.id,
        task.workspaceId,
        'create_share',
        idempotencyHeader || `${request.params.taskId}:share_create`
      );

      const result = await IdempotencyService.runIdempotent(scopeKey, parsed.data, async () => {
        const share = await ShareService.createShare(request.actor!, request.params.taskId, parsed.data);
        return { statusCode: 201, result: share };
      });

      return reply.status(result.statusCode).send(result.result);
    }
  );

  // GET /tasks/:taskId/shares - Lista links de compartilhamento da tarefa
  fastify.get(
    '/tasks/:taskId/shares',
    {
      config: {
        policy: {
          action: 'list',
          resource: 'shares',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { taskId: string }; Querystring: { cursor?: string; limit?: string } }>,
      reply: FastifyReply
    ) => {
      const result = await ShareService.listTaskShares(request.actor!, request.params.taskId, request.query);
      return reply.send(result);
    }
  );

  // PATCH /shares/:shareId - Atualiza seções ou validade com controle de concorrência
  fastify.patch(
    '/shares/:shareId',
    {
      config: {
        policy: {
          action: 'edit',
          resource: 'shares',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { shareId: string }; Body: unknown }>, reply: FastifyReply) => {
      const parsed = patchShareSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Parâmetros de atualização inválidos', parsed.error.format());
      }

      const updated = await ShareService.patchShare(request.actor!, request.params.shareId, parsed.data);
      return reply.send(updated);
    }
  );

  // POST /shares/:shareId/revoke - Revoga ativamente o link
  fastify.post(
    '/shares/:shareId/revoke',
    {
      config: {
        policy: {
          action: 'revoke',
          resource: 'shares',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { shareId: string } }>, reply: FastifyReply) => {
      const result = await ShareService.revokeShare(request.actor!, request.params.shareId);
      return reply.send(result);
    }
  );

  // POST /shares/:shareId/reissue - Reemite novos segredos e invalida o anterior
  fastify.post(
    '/shares/:shareId/reissue',
    {
      config: {
        policy: {
          action: 'reissue',
          resource: 'shares',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { shareId: string } }>, reply: FastifyReply) => {
      const newShare = await ShareService.reissueShare(request.actor!, request.params.shareId);
      return reply.status(201).send(newShare);
    }
  );
}
