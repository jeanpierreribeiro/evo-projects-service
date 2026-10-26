import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskService } from '../services/task.service.js';
import { ApprovalService } from '../services/approval.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { Priority, RelationType } from '@prisma/client';

const createTaskSchema = z.object({
  title: z.string().min(1, 'Título é obrigatório'),
  description: z.string().optional(),
  columnId: z.string().optional(),
  priority: z.nativeEnum(Priority).optional(),
  assigneeId: z.string().optional(),
  assigneeName: z.string().optional(),
  assigneeAvatar: z.string().optional(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  estimatedHours: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

const updateTaskSchema = createTaskSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

const moveTaskSchema = z.object({
  targetColumnId: z.string().min(1),
  targetPosition: z.number().int().min(0),
});

export async function tasksRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /projects/:projectId/tasks - List project tasks
  fastify.get('/projects/:projectId/tasks', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const query = request.query as { columnId?: string; assigneeId?: string; priority?: Priority };

    const tasks = await TaskService.listByProject(projectId, query);
    return { data: tasks };
  });

  // GET /workspaces/:workspaceId/my-tasks - List operator's tasks in workspace
  fastify.get('/workspaces/:workspaceId/my-tasks', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const user = request.user!;

    const tasks = await TaskService.listMyTasks(workspaceId, user.id);
    return { data: tasks };
  });

  // POST /projects/:projectId/tasks - Create task
  fastify.post('/projects/:projectId/tasks', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const actor = request.user!;

    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    const task = await TaskService.createTask(projectId, parsed.data, actor);
    return reply.status(201).send({ data: task });
  });

  // GET /tasks/:id - Get full task details
  fastify.get('/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await TaskService.getTask(id);
    if (!task) return reply.status(404).send({ error: 'Tarefa não encontrada' });
    return { data: task };
  });

  // PUT /tasks/:id - Update task
  fastify.put('/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.user!;

    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    const task = await TaskService.updateTask(id, parsed.data, actor);
    return { data: task };
  });

  // PUT /tasks/:id/move - Move task (drag & drop)
  fastify.put('/tasks/:id/move', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.user!;

    const parsed = moveTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Parâmetros de movimentação inválidos' });
    }

    const task = await TaskService.moveTask(id, parsed.data.targetColumnId, parsed.data.targetPosition, actor);
    return { data: task };
  });

  // DELETE /tasks/:id - Delete task
  fastify.delete('/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.user!;

    await TaskService.deleteTask(id, actor);
    return { message: 'Tarefa excluída com sucesso' };
  });

  // POST /tasks/:id/approval/generate - Generate client approval PIN and token
  fastify.post('/tasks/:id/approval/generate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.user!;

    const result = await ApprovalService.generateLink(id, actor);
    return { data: result };
  });

  // --- Subtasks ---
  fastify.post('/tasks/:taskId/subtasks', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { title } = request.body as { title: string };
    if (!title?.trim()) return reply.status(400).send({ error: 'Título da subtarefa é obrigatório' });

    const subtask = await TaskService.addSubtask(taskId, title.trim());
    return reply.status(201).send({ data: subtask });
  });

  fastify.put('/subtasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as { title?: string; completed?: boolean; position?: number };
    const subtask = await TaskService.updateSubtask(id, data);
    return { data: subtask };
  });

  fastify.delete('/subtasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await TaskService.deleteSubtask(id);
    return { message: 'Subtarefa removida' };
  });

  // --- Relations ---
  fastify.post('/tasks/:taskId/relations', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { relatedTaskId, type } = request.body as { relatedTaskId: string; type: RelationType };
    if (!relatedTaskId || !type) return reply.status(400).send({ error: 'relatedTaskId e type são obrigatórios' });

    const relation = await TaskService.addRelation(taskId, relatedTaskId, type);
    return reply.status(201).send({ data: relation });
  });

  fastify.delete('/relations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await TaskService.removeRelation(id);
    return { message: 'Relação removida' };
  });

  // --- Resources ---
  fastify.post('/tasks/:taskId/resources', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const data = request.body as { title: string; url: string; type?: string };
    if (!data.title || !data.url) return reply.status(400).send({ error: 'title e url são obrigatórios' });

    const resource = await TaskService.addResource(taskId, data);
    return reply.status(201).send({ data: resource });
  });

  fastify.delete('/resources/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await TaskService.removeResource(id);
    return { message: 'Recurso removido' };
  });

  // --- Time Entries ---
  fastify.post('/tasks/:taskId/time-entries', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const actor = request.user!;
    const data = request.body as { description?: string; durationMinutes: number; date?: string };

    const entry = await TaskService.addTimeEntry(taskId, data, actor);
    return reply.status(201).send({ data: entry });
  });

  fastify.delete('/time-entries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await TaskService.removeTimeEntry(id);
    return { message: 'Apontamento removido' };
  });

  // --- Comments ---
  fastify.post('/tasks/:taskId/comments', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const actor = request.user!;
    const { content } = request.body as { content: string };
    if (!content?.trim()) return reply.status(400).send({ error: 'Conteúdo do comentário é obrigatório' });

    const comment = await TaskService.addComment(taskId, content, actor);
    return reply.status(201).send({ data: comment });
  });

  fastify.delete('/comments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await TaskService.deleteComment(id);
    return { message: 'Comentário removido' };
  });
}
