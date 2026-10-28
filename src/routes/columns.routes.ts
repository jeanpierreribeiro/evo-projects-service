import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../db/prisma.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { AccessService } from '../services/access.service.js';
import { ValidationError, NotFoundError } from '../errors/app-error.js';
import { withProjectLock, withTransaction } from '../db/tx.js';
import { ActivityService } from '../services/activity.service.js';

const createColumnSchema = z
  .object({
    name: z.string().min(1, 'Nome da coluna é obrigatório').max(100),
    color: z.string().optional(),
    isDoneColumn: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

const updateColumnSchema = createColumnSchema.partial().strict();

const reorderColumnsSchema = z
  .object({
    columns: z.array(
      z
        .object({
          id: z.string().min(1),
          position: z.number().int().min(0),
        })
        .strict()
    ),
  })
  .strict();

export async function columnsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /projects/:projectId/columns - List columns
  fastify.get(
    '/projects/:projectId/columns',
    {
      config: {
        policy: {
          action: 'read_column',
          resource: 'column',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      const actor = request.actor!;

      const project = await AccessService.getAuthorizedProject(projectId, actor, 'read_column');

      const columns = await prisma.column.findMany({
        where: { projectId: project.id },
        orderBy: { position: 'asc' },
      });
      return { data: columns };
    }
  );

  // POST /projects/:projectId/columns - Create column
  fastify.post(
    '/projects/:projectId/columns',
    {
      config: {
        policy: {
          action: 'manage_columns',
          resource: 'column',
          minRole: 'ADMIN',
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const actor = request.actor!;

      const project = await AccessService.getAuthorizedProject(projectId, actor, 'manage_columns');

      const parsed = createColumnSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      let position = parsed.data.position;
      if (position === undefined) {
        const last = await prisma.column.findFirst({
          where: { projectId: project.id },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        position = last ? last.position + 1 : 0;
      }

      const column = await prisma.column.create({
        data: {
          projectId: project.id,
          name: parsed.data.name,
          color: parsed.data.color || '#94a3b8',
          isDoneColumn: parsed.data.isDoneColumn || false,
          position,
        },
      });

      return reply.status(201).send({ data: column });
    }
  );

  // PUT /columns/:id - Update column
  const updateColumnHandler = async (request: any) => {
    const { id } = request.params as { id: string };
    const actor = request.actor!;

    const existing = await AccessService.getAuthorizedColumn(id, actor, 'manage_columns');

    const parsed = updateColumnSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
    }

    const project = await prisma.project.findUnique({
      where: { id: existing.projectId },
      include: { columns: true },
    });
    if (!project) throw new NotFoundError('Projeto não encontrado.');

    if (parsed.data.isDoneColumn === false && existing.isDoneColumn) {
      const otherDone = project.columns.filter((c) => c.id !== existing.id && c.isDoneColumn);
      if (otherDone.length === 0) {
        throw new ValidationError('O projeto precisa ter pelo menos uma coluna de conclusão (isDoneColumn).');
      }
    }

    if (parsed.data.isDoneColumn === true && project.backlogColumnId === existing.id) {
      throw new ValidationError('A coluna configurada como Backlog não pode ser definida como coluna de conclusão.');
    }

    const column = await prisma.column.update({
      where: { id: existing.id },
      data: parsed.data,
    });
    return { data: column };
  };

  fastify.put(
    '/columns/:id',
    {
      config: {
        policy: {
          action: 'manage_columns',
          resource: 'column',
          minRole: 'ADMIN',
        },
      },
    },
    updateColumnHandler
  );

  fastify.patch(
    '/columns/:id',
    {
      config: {
        policy: {
          action: 'manage_columns',
          resource: 'column',
          minRole: 'ADMIN',
        },
      },
    },
    updateColumnHandler
  );

  // PUT /projects/:projectId/columns/reorder - Reorder columns
  fastify.put(
    '/projects/:projectId/columns/reorder',
    {
      config: {
        policy: {
          action: 'manage_columns',
          resource: 'column',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      const actor = request.actor!;

      const project = await AccessService.getAuthorizedProject(projectId, actor, 'manage_columns');

      const parsed = reorderColumnsSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Lista de ordenação inválida.');
      }

      // Valida que TODAS as colunas pertencem ao projeto (E1.4-c: checagem de cada ID em lote)
      const columnIds = parsed.data.columns.map((c) => c.id);
      const existingCount = await prisma.column.count({
        where: {
          id: { in: columnIds },
          projectId: project.id,
        },
      });

      if (existingCount !== columnIds.length) {
        throw new NotFoundError('Uma ou mais colunas não pertencem ao projeto indicado.');
      }

      await withProjectLock(project.id, async (tx) => {
        for (const item of parsed.data.columns) {
          await tx.column.update({
            where: { id: item.id },
            data: {
              position: item.position,
              orderVersion: { increment: 1 },
            },
          });
        }

        await ActivityService.log(
          {
            workspaceId: project.workspaceId,
            projectId: project.id,
            userId: actor.id,
            userName: (actor as any).name || 'Usuário',
            action: 'reordered_columns',
            details: { columnCount: parsed.data.columns.length },
          },
          tx
        );
      });

      return { success: true };
    }
  );

  // DELETE /columns/:id - Delete column
  fastify.delete(
    '/columns/:id',
    {
      config: {
        policy: {
          action: 'manage_columns',
          resource: 'column',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = (request.query || {}) as any;
      const body = (request.body || {}) as any;
      const destinationColumnId = body.destinationColumnId || query.destinationColumnId;
      const actor = request.actor!;

      const existing = await AccessService.getAuthorizedColumn(id, actor, 'manage_columns');
      const project = await prisma.project.findUnique({
        where: { id: existing.projectId },
        include: { columns: true },
      });
      if (!project) throw new NotFoundError('Projeto não encontrado.');

      if (project.backlogColumnId === existing.id) {
        throw new ValidationError('Esta coluna está configurada como Backlog do projeto. Defina outra coluna como Backlog antes de excluí-la.');
      }

      if (project.columns.length <= 1) {
        throw new ValidationError('O projeto precisa ter pelo menos uma coluna.');
      }

      if (existing.isDoneColumn) {
        const otherDone = project.columns.filter((c) => c.id !== existing.id && c.isDoneColumn);
        if (otherDone.length === 0) {
          throw new ValidationError('O projeto precisa ter pelo menos uma coluna de conclusão. Defina outra antes de excluir esta.');
        }
      }

      const taskCount = await prisma.task.count({
        where: { columnId: existing.id },
      });

      if (taskCount > 0) {
        if (!destinationColumnId) {
          throw new ValidationError('A coluna possui tarefas vinculadas. É necessário informar destinationColumnId do mesmo projeto para transferi-las antes de excluir.');
        }
        if (destinationColumnId === existing.id) {
          throw new ValidationError('A coluna de destino não pode ser a própria coluna a ser excluída.');
        }
        const destination = project.columns.find((c) => c.id === destinationColumnId);
        if (!destination) {
          throw new NotFoundError('Coluna de destino não encontrada no mesmo projeto.');
        }
      }

      await withProjectLock(project.id, async (tx) => {
        if (taskCount > 0 && destinationColumnId) {
          await tx.task.updateMany({
            where: { columnId: existing.id },
            data: { columnId: destinationColumnId },
          });
        }
        await tx.column.delete({
          where: { id: existing.id },
        });

        await ActivityService.log(
          {
            workspaceId: project.workspaceId,
            projectId: project.id,
            userId: actor.id,
            userName: (actor as any).name || 'Usuário',
            action: 'deleted_column',
            details: { columnName: existing.name, movedTasks: taskCount },
          },
          tx
        );
      });

      return { message: 'Coluna excluída com sucesso', movedTasks: taskCount };
    }
  );
}
