import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CustomFieldService, CustomFieldType } from '../services/custom-field.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { ValidationError } from '../errors/app-error.js';

const createCustomFieldSchema = z
  .object({
    name: z.string().min(1, 'Nome do campo é obrigatório').max(100),
    type: z.enum(['text', 'number', 'select', 'date']),
    options: z.array(z.any()).optional(),
    isPublicEligible: z.boolean().optional(),
  })
  .strict();

const updateCustomFieldSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    options: z.array(z.any()).optional(),
    isPublicEligible: z.boolean().optional(),
  })
  .strict();

const setTaskValuesSchema = z
  .object({
    values: z.array(
      z.object({
        fieldId: z.string().min(1),
        value: z.any(),
      })
    ),
  })
  .strict();

export async function customFieldsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /projects/:projectId/custom-fields - Listar campos do projeto (E3.8-a)
  fastify.get(
    '/projects/:projectId/custom-fields',
    {
      config: {
        policy: {
          action: 'read_project',
          resource: 'project',
          minRole: 'VIEWER',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { projectId: string } }>) => {
      const { projectId } = request.params;
      const actor = request.actor!;

      const fields = await CustomFieldService.listProjectCustomFields(projectId, actor);
      return { data: fields };
    }
  );

  // POST /projects/:projectId/custom-fields - Criar campo no projeto (E3.8-a / ADMIN)
  fastify.post(
    '/projects/:projectId/custom-fields',
    {
      config: {
        policy: {
          action: 'manage_project',
          resource: 'project',
          minRole: 'ADMIN',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { projectId: string } }>,
      reply: FastifyReply
    ) => {
      const { projectId } = request.params;
      const actor = request.actor!;

      const parsed = createCustomFieldSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const field = await CustomFieldService.createCustomField({
        projectId,
        name: parsed.data.name,
        type: parsed.data.type as CustomFieldType,
        options: parsed.data.options,
        isPublicEligible: parsed.data.isPublicEligible,
        actor,
      });

      return reply.status(201).send({ data: field });
    }
  );

  // PATCH /custom-fields/:id - Atualizar definição de campo (E3.8-a / ADMIN)
  fastify.patch(
    '/custom-fields/:id',
    {
      config: {
        policy: {
          action: 'manage_project',
          resource: 'project',
          minRole: 'ADMIN',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const { id } = request.params;
      const actor = request.actor!;

      const parsed = updateCustomFieldSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const updated = await CustomFieldService.updateCustomField({
        fieldId: id,
        name: parsed.data.name,
        options: parsed.data.options,
        isPublicEligible: parsed.data.isPublicEligible,
        actor,
      });

      return { data: updated };
    }
  );

  // DELETE /custom-fields/:id - Excluir campo (E3.8-a / ADMIN)
  fastify.delete(
    '/custom-fields/:id',
    {
      config: {
        policy: {
          action: 'manage_project',
          resource: 'project',
          minRole: 'ADMIN',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const { id } = request.params;
      const actor = request.actor!;

      await CustomFieldService.deleteCustomField(id, actor);
      return { message: 'Campo personalizado removido com sucesso.' };
    }
  );

  // GET /tasks/:taskId/custom-field-values - Listar valores dos campos de uma tarefa (E3.8-a)
  fastify.get(
    '/tasks/:taskId/custom-field-values',
    {
      config: {
        policy: {
          action: 'read_task',
          resource: 'task',
          minRole: 'VIEWER',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { taskId: string } }>) => {
      const { taskId } = request.params;
      const actor = request.actor!;

      const values = await CustomFieldService.getTaskCustomFieldValues(taskId, actor);
      return { data: values };
    }
  );

  // PUT /tasks/:taskId/custom-field-values - Atualizar valores dos campos em lote (E3.8-a / MEMBER)
  fastify.put(
    '/tasks/:taskId/custom-field-values',
    {
      config: {
        policy: {
          action: 'edit_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { taskId: string } }>) => {
      const { taskId } = request.params;
      const actor = request.actor!;

      const parsed = setTaskValuesSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const updated = await CustomFieldService.bulkSetTaskCustomFieldValues({
        taskId,
        values: parsed.data.values,
        actor,
      });

      return { data: updated };
    }
  );
}
