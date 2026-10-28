import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskService } from '../services/task.service.js';
import { TransferService } from '../services/transfer.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { Priority, RelationType } from '@prisma/client';
import { GoneError, ValidationError } from '../errors/app-error.js';
import { LIMITS } from '../config/limits.js';
import { IdempotencyService } from '../services/idempotency.service.js';
import { AccessService } from '../services/access.service.js';

const createTaskSchema = z
  .object({
    title: z.string().min(1, 'Título é obrigatório').max(LIMITS.TITLE_MAX_LENGTH),
    description: z.string().max(LIMITS.DESCRIPTION_MAX_LENGTH).optional(),
    columnId: z.string().optional(),
    priority: z.nativeEnum(Priority).optional(),
    assigneeId: z.string().optional(),
    assigneeName: z.string().max(LIMITS.NAME_MAX_LENGTH).optional(),
    assigneeAvatar: z.string().url().optional(),
    startDate: z.string().optional(),
    dueDate: z.string().optional(),
    estimatedMinutes: z.number().int().positive().max(LIMITS.ESTIMATED_MINUTES_MAX).optional(),
    estimatedHours: z.number().positive().max(LIMITS.ESTIMATED_HOURS_MAX).optional(),
    tags: z.array(z.string().max(LIMITS.TAG_MAX_LENGTH)).max(LIMITS.TAGS_MAX_COUNT).optional(),
  })
  .strict();

const patchTaskSchema = z
  .object({
    title: z.string().min(1, 'Título não pode ser vazio').max(LIMITS.TITLE_MAX_LENGTH).optional(),
    description: z.string().max(LIMITS.DESCRIPTION_MAX_LENGTH).nullable().optional(),
    columnId: z.string().min(1).optional(),
    priority: z.nativeEnum(Priority).optional(),
    assigneeId: z.string().nullable().optional(),
    assigneeName: z.string().max(LIMITS.NAME_MAX_LENGTH).nullable().optional(),
    assigneeAvatar: z.string().url().nullable().optional(),
    startDate: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    estimatedMinutes: z.number().int().positive().max(LIMITS.ESTIMATED_MINUTES_MAX).nullable().optional(),
    estimatedHours: z.number().positive().max(LIMITS.ESTIMATED_HOURS_MAX).nullable().optional(),
    tags: z.array(z.string().max(LIMITS.TAG_MAX_LENGTH)).max(LIMITS.TAGS_MAX_COUNT).optional(),
    isArchived: z.boolean().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

const moveTaskSchema = z
  .object({
    targetColumnId: z.string().min(1),
    targetPosition: z.number().int().min(0),
  })
  .strict();

const createSubtaskSchema = z
  .object({
    title: z.string().min(1, 'Título da subtarefa é obrigatório').max(300),
  })
  .strict();

const updateSubtaskSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    completed: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

const createRelationSchema = z
  .object({
    relatedTaskId: z.string().min(1),
    type: z.nativeEnum(RelationType),
  })
  .strict();

const createResourceSchema = z
  .object({
    title: z.string().min(1, 'Título do recurso é obrigatório').max(200),
    url: z.string().url('URL inválida'),
    type: z.string().max(50).optional(),
  })
  .strict();

const createTimeEntrySchema = z
  .object({
    description: z.string().max(1000).optional(),
    durationMinutes: z.number().int().positive('Duração em minutos deve ser positiva').max(10000),
    date: z.string().optional(),
  })
  .strict();

const updateTimeEntrySchema = z
  .object({
    description: z.string().max(1000).optional(),
    durationMinutes: z.number().int().positive('Duração em minutos deve ser positiva').max(10000).optional(),
    date: z.string().optional(),
  })
  .strict();

const createCommentSchema = z
  .object({
    content: z.string().min(1, 'Conteúdo do comentário é obrigatório').max(10000),
    mentionUserIds: z.array(z.string()).optional(),
  })
  .strict();

const updateCommentSchema = z
  .object({
    content: z.string().min(1, 'Conteúdo do comentário é obrigatório').max(10000),
    mentionUserIds: z.array(z.string()).optional(),
  })
  .strict();

export async function tasksRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /metadata/limits - Retorna limites operacionais espelhados (E3.1-d)
  fastify.get(
    '/metadata/limits',
    {
      config: {
        policy: {
          action: 'read_workspace',
          resource: 'workspace',
          minRole: 'VIEWER',
        },
      },
    },
    async () => {
      return { data: LIMITS };
    }
  );

  // GET /projects/:projectId/tasks - List project tasks with cursor pagination
  fastify.get(
    '/projects/:projectId/tasks',
    {
      config: {
        policy: {
          action: 'read_task',
          resource: 'task',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      const query = request.query as any;
      const actor = request.actor!;

      return TaskService.listByProject(projectId, actor, query);
    }
  );

  // GET /workspaces/:workspaceId/my-tasks - List operator's tasks in workspace with cursor pagination
  fastify.get(
    '/workspaces/:workspaceId/my-tasks',
    {
      config: {
        policy: {
          action: 'read_task',
          resource: 'task',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const query = request.query as any;
      const actor = request.actor!;

      return TaskService.listMyTasks(workspaceId, actor, query);
    }
  );

  // POST /projects/:projectId/tasks - Create task
  fastify.post(
    '/projects/:projectId/tasks',
    {
      config: {
        policy: {
          action: 'create_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const actor = request.actor!;
      const idempotencyKey = (request.headers['idempotency-key'] as string) || undefined;

      const parsed = createTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      if (idempotencyKey) {
        const project = await AccessService.getAuthorizedProject(projectId, actor, 'create_task');
        const scopeKey = IdempotencyService.buildScopeKey(
          actor.id,
          project.workspaceId,
          'create_task',
          idempotencyKey
        );

        const result = await IdempotencyService.runIdempotent(scopeKey, parsed.data, async () => {
          const task = await TaskService.createTask(projectId, parsed.data, actor);
          return { statusCode: 201, result: { data: task } };
        });

        return reply.status(result.statusCode).send(result.result);
      }

      const task = await TaskService.createTask(projectId, parsed.data, actor);
      return reply.status(201).send({ data: task });
    }
  );

  // GET /tasks/:id - Get full task details
  fastify.get(
    '/tasks/:id',
    {
      config: {
        policy: {
          action: 'read_task',
          resource: 'task',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;
      const task = await TaskService.getTask(id, actor);
      return { data: task };
    }
  );

  const handleUpdateTask = async (request: any) => {
    const { id } = request.params as { id: string };
    const actor = request.actor!;

    if (request.body && typeof request.body === 'object' && 'projectId' in request.body) {
      throw new ValidationError(
        'Transferência de projeto deve ser realizada exclusivamente via POST /tasks/:taskId/transfer.'
      );
    }

    const parsed = patchTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
    }

    const task = await TaskService.updateTask(id, parsed.data, actor);
    return { data: task };
  };

  // PATCH /tasks/:id - Partial update with expectedVersion (E3.1-a / E3.1-b)
  fastify.patch(
    '/tasks/:id',
    {
      config: {
        policy: {
          action: 'edit_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    handleUpdateTask
  );

  // PUT /tasks/:id - Update task (alias para compatibilidade)
  fastify.put(
    '/tasks/:id',
    {
      config: {
        policy: {
          action: 'edit_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    handleUpdateTask
  );

  // PUT /tasks/:id/move - Move task (drag & drop)
  fastify.put(
    '/tasks/:id/move',
    {
      config: {
        policy: {
          action: 'move_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const parsed = moveTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Parâmetros de movimentação inválidos');
      }

      const task = await TaskService.moveTask(
        id,
        parsed.data.targetColumnId,
        parsed.data.targetPosition,
        actor
      );
      return { data: task };
    }
  );

  // DELETE /tasks/:id - Delete task (ADMIN only / soft-delete)
  fastify.delete(
    '/tasks/:id',
    {
      config: {
        policy: {
          action: 'delete_task',
          resource: 'task',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;
      const { reason } = (request.body as any) || {};

      const task = await TaskService.deleteTask(id, actor, reason);
      return { message: 'Tarefa excluída com sucesso', data: task };
    }
  );

  // POST /tasks/:id/archive - Archive task (MEMBER allowed if parents active)
  fastify.post(
    '/tasks/:id/archive',
    {
      config: {
        policy: {
          action: 'archive_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const task = await TaskService.archiveTask(id, actor);
      return { data: task };
    }
  );

  // POST /tasks/:id/restore - Restore task (ADMIN required if parents archived or soft-deleted)
  fastify.post(
    '/tasks/:id/restore',
    {
      config: {
        policy: {
          action: 'restore_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const task = await TaskService.restoreTask(id, actor);
      return { data: task };
    }
  );

  // POST /tasks/:taskId/transfer/preview - Preview cross-project transfer (E3.6-e)
  fastify.post(
    '/tasks/:taskId/transfer/preview',
    {
      config: {
        policy: {
          action: 'transfer_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const { targetProjectId } = request.body as { targetProjectId: string };
      if (!targetProjectId) {
        throw new ValidationError('targetProjectId é obrigatório.');
      }
      const actor = request.actor!;

      const preview = await TransferService.preview(taskId, targetProjectId, actor);
      return { data: preview };
    }
  );

  // POST /tasks/:taskId/transfer - Execute cross-project transfer (E3.6-e)
  fastify.post(
    '/tasks/:taskId/transfer',
    {
      config: {
        policy: {
          action: 'transfer_task',
          resource: 'task',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const { targetProjectId, targetColumnId } = request.body as {
        targetProjectId: string;
        targetColumnId: string;
      };
      if (!targetProjectId || !targetColumnId) {
        throw new ValidationError('targetProjectId e targetColumnId são obrigatórios.');
      }
      const actor = request.actor!;

      const task = await TransferService.execute({
        taskId,
        targetProjectId,
        targetColumnId,
        actor,
      });
      return { data: task };
    }
  );

  // POST /tasks/:id/approval/generate - Rota de aprovação legada bloqueada com 410 (E1.2-c)
  fastify.post(
    '/tasks/:id/approval/generate',
    {
      config: {
        policy: {
          action: 'legacy_approval_deprecated',
          resource: 'task',
          minRole: 'ADMIN',
        },
      },
    },
    async () => {
      throw new GoneError('Esta funcionalidade de aprovação com PIN de 4 dígitos foi descontinuada.');
    }
  );

  // --- Subtasks ---
  fastify.post(
    '/tasks/:taskId/subtasks',
    {
      config: {
        policy: {
          action: 'create_subtask',
          resource: 'subtask',
          minRole: 'MEMBER',
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const actor = request.actor!;

      const parsed = createSubtaskSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const subtask = await TaskService.addSubtask(taskId, parsed.data.title.trim(), actor);
      return reply.status(201).send({ data: subtask });
    }
  );

  fastify.put(
    '/subtasks/:id',
    {
      config: {
        policy: {
          action: 'edit_subtask',
          resource: 'subtask',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const parsed = updateSubtaskSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const subtask = await TaskService.updateSubtask(id, parsed.data, actor);
      return { data: subtask };
    }
  );

  fastify.delete(
    '/subtasks/:id',
    {
      config: {
        policy: {
          action: 'delete_subtask',
          resource: 'subtask',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      await TaskService.deleteSubtask(id, actor);
      return { message: 'Subtarefa removida' };
    }
  );

  // --- Relations ---
  fastify.post(
    '/tasks/:taskId/relations',
    {
      config: {
        policy: {
          action: 'create_relation',
          resource: 'relation',
          minRole: 'MEMBER',
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const actor = request.actor!;

      const parsed = createRelationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const relation = await TaskService.addRelation(
        taskId,
        parsed.data.relatedTaskId,
        parsed.data.type,
        actor
      );
      return reply.status(201).send({ data: relation });
    }
  );

  fastify.delete(
    '/relations/:id',
    {
      config: {
        policy: {
          action: 'delete_relation',
          resource: 'relation',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      await TaskService.removeRelation(id, actor);
      return { message: 'Relação removida' };
    }
  );

  // --- Resources ---
  fastify.post(
    '/tasks/:taskId/resources',
    {
      config: {
        policy: {
          action: 'create_resource',
          resource: 'resource',
          minRole: 'MEMBER',
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const actor = request.actor!;

      const parsed = createResourceSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const resource = await TaskService.addResource(taskId, parsed.data, actor);
      return reply.status(201).send({ data: resource });
    }
  );

  fastify.delete(
    '/resources/:id',
    {
      config: {
        policy: {
          action: 'delete_resource',
          resource: 'resource',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      await TaskService.removeResource(id, actor);
      return { message: 'Recurso removido' };
    }
  );

  // --- Time Entries ---
  fastify.post(
    '/tasks/:taskId/time-entries',
    {
      config: {
        policy: {
          action: 'create_time_entry',
          resource: 'time_entry',
          minRole: 'MEMBER',
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const actor = request.actor!;

      const parsed = createTimeEntrySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const entry = await TaskService.addTimeEntry(taskId, parsed.data, actor);
      return reply.status(201).send({ data: entry });
    }
  );

  fastify.patch(
    '/time-entries/:id',
    {
      config: {
        policy: {
          action: 'edit_time_entry',
          resource: 'time_entry',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const parsed = updateTimeEntrySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const updated = await TaskService.updateTimeEntry(id, parsed.data, actor);
      return { data: updated };
    }
  );

  fastify.get(
    '/tasks/:taskId/time-entries',
    {
      config: {
        policy: {
          action: 'read_task',
          resource: 'time_entry',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const actor = request.actor!;

      const result = await TaskService.listTimeEntries(taskId, actor);
      return { data: result };
    }
  );

  fastify.delete(
    '/time-entries/:id',
    {
      config: {
        policy: {
          action: 'delete_time_entry',
          resource: 'time_entry',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      await TaskService.removeTimeEntry(id, actor);
      return { message: 'Apontamento removido' };
    }
  );

  // --- Comments ---
  fastify.post(
    '/tasks/:taskId/comments',
    {
      config: {
        policy: {
          action: 'create_comment',
          resource: 'comment',
          minRole: 'MEMBER',
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const actor = request.actor!;

      const parsed = createCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const comment = await TaskService.addComment(
        taskId,
        parsed.data.content,
        actor,
        parsed.data.mentionUserIds
      );
      return reply.status(201).send({ data: comment });
    }
  );

  fastify.patch(
    '/comments/:id',
    {
      config: {
        policy: {
          action: 'edit_comment',
          resource: 'comment',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const parsed = updateCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const updated = await TaskService.updateComment(
        id,
        parsed.data.content,
        actor,
        parsed.data.mentionUserIds
      );
      return { data: updated };
    }
  );

  fastify.delete(
    '/comments/:id',
    {
      config: {
        policy: {
          action: 'delete_comment',
          resource: 'comment',
          minRole: 'MEMBER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      await TaskService.deleteComment(id, actor);
      return { message: 'Comentário removido' };
    }
  );

  // GET /tasks/:taskId/comments - List comments with cursor pagination (E3.1-c)
  fastify.get(
    '/tasks/:taskId/comments',
    {
      config: {
        policy: {
          action: 'read_task',
          resource: 'task',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const actor = request.actor!;
      const query = request.query as any;

      return TaskService.listComments(taskId, actor, query);
    }
  );
}
