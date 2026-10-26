import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProjectService } from '../services/project.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Nome do projeto é obrigatório'),
  description: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
});

const updateProjectSchema = createProjectSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

export async function projectsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /workspaces/:workspaceId/projects - List workspace projects
  fastify.get('/workspaces/:workspaceId/projects', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { includeArchived } = request.query as { includeArchived?: string };

    const projects = await ProjectService.listByWorkspace(workspaceId, includeArchived === 'true');
    return { data: projects };
  });

  // POST /workspaces/:workspaceId/projects - Create project
  fastify.post('/workspaces/:workspaceId/projects', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const actor = request.user!;

    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    const project = await ProjectService.createProject(workspaceId, parsed.data, actor);
    return reply.status(201).send({ data: project });
  });

  // GET /projects/:id - Get project details
  fastify.get('/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await ProjectService.getProject(id);
    if (!project) return reply.status(404).send({ error: 'Projeto não encontrado' });
    return { data: project };
  });

  // PUT /projects/:id - Update project
  fastify.put('/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.user!;

    const parsed = updateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    const project = await ProjectService.updateProject(id, parsed.data, actor);
    return { data: project };
  });

  // DELETE /projects/:id - Delete project
  fastify.delete('/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.user!;

    await ProjectService.deleteProject(id, actor);
    return { message: 'Projeto excluído com sucesso' };
  });
}
