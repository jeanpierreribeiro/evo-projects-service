import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../db/prisma.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const createColumnSchema = z.object({
  name: z.string().min(1, 'Nome da coluna é obrigatório'),
  color: z.string().optional(),
  isDoneColumn: z.boolean().optional(),
  position: z.number().optional(),
});

const updateColumnSchema = createColumnSchema.partial();

const reorderColumnsSchema = z.object({
  columns: z.array(
    z.object({
      id: z.string(),
      position: z.number(),
    })
  ),
});

export async function columnsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /projects/:projectId/columns - List columns
  fastify.get('/projects/:projectId/columns', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const columns = await prisma.column.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
    });
    return { data: columns };
  });

  // POST /projects/:projectId/columns - Create column
  fastify.post('/projects/:projectId/columns', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = createColumnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    let position = parsed.data.position;
    if (position === undefined) {
      const last = await prisma.column.findFirst({
        where: { projectId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      position = last ? last.position + 1 : 0;
    }

    const column = await prisma.column.create({
      data: {
        projectId,
        name: parsed.data.name,
        color: parsed.data.color || '#94a3b8',
        isDoneColumn: parsed.data.isDoneColumn || false,
        position,
      },
    });

    return reply.status(201).send({ data: column });
  });

  // PUT /columns/:id - Update column
  fastify.put('/columns/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateColumnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    const column = await prisma.column.update({
      where: { id },
      data: parsed.data,
    });
    return { data: column };
  });

  // PUT /projects/:projectId/columns/reorder - Reorder columns
  fastify.put('/projects/:projectId/columns/reorder', async (request, reply) => {
    const parsed = reorderColumnsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Lista de ordenação inválida' });
    }

    await prisma.$transaction(
      parsed.data.columns.map((item) =>
        prisma.column.update({
          where: { id: item.id },
          data: { position: item.position },
        })
      )
    );

    return { success: true };
  });

  // DELETE /columns/:id - Delete column
  fastify.delete('/columns/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.column.delete({
      where: { id },
    });
    return { message: 'Coluna removida com sucesso' };
  });
}
