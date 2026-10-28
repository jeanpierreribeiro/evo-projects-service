import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LabelService } from '../services/label.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { ValidationError } from '../errors/app-error.js';

const createLabelSchema = z
  .object({
    name: z.string().min(1, 'Nome da etiqueta é obrigatório').max(50),
    color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Formato hexadecimal inválido').optional(),
  })
  .strict();

const updateLabelSchema = createLabelSchema.partial().strict();

export async function labelsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /workspaces/:workspaceId/labels - List labels
  fastify.get(
    '/workspaces/:workspaceId/labels',
    {
      config: {
        policy: {
          action: 'read_label',
          resource: 'workspace',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const actor = request.actor!;
      const labels = await LabelService.listByWorkspace(workspaceId, actor);
      return { data: labels };
    }
  );

  // POST /workspaces/:workspaceId/labels - Create label
  fastify.post(
    '/workspaces/:workspaceId/labels',
    {
      config: {
        policy: {
          action: 'manage_labels',
          resource: 'workspace',
          minRole: 'ADMIN',
        },
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const actor = request.actor!;

      const parsed = createLabelSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const label = await LabelService.createLabel(workspaceId, parsed.data, actor);
      return reply.status(201).send({ data: label });
    }
  );

  // PATCH /labels/:id - Update label
  fastify.patch(
    '/labels/:id',
    {
      config: {
        policy: {
          action: 'manage_labels',
          resource: 'workspace',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const parsed = updateLabelSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const label = await LabelService.updateLabel(id, parsed.data, actor);
      return { data: label };
    }
  );

  // PUT /labels/:id - Update label (compat)
  fastify.put(
    '/labels/:id',
    {
      config: {
        policy: {
          action: 'manage_labels',
          resource: 'workspace',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const parsed = updateLabelSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const label = await LabelService.updateLabel(id, parsed.data, actor);
      return { data: label };
    }
  );

  // DELETE /labels/:id - Delete label
  fastify.delete(
    '/labels/:id',
    {
      config: {
        policy: {
          action: 'manage_labels',
          resource: 'workspace',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      return LabelService.deleteLabel(id, actor);
    }
  );
}
