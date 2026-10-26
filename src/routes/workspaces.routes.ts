import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspace.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const createWorkspaceSchema = z.object({
  name: z.string().min(1, 'Nome é obrigatório'),
  description: z.string().optional(),
  color: z.string().optional(),
  avatarUrl: z.string().optional(),
});

const updateWorkspaceSchema = createWorkspaceSchema.partial();

const addMemberSchema = z.object({
  userId: z.string().min(1, 'userId é obrigatório'),
  email: z.string().email('Email inválido'),
  name: z.string().min(1, 'Nome é obrigatório'),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional(),
  avatarUrl: z.string().optional(),
});

export async function workspacesRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /workspaces - List user's workspaces
  fastify.get('/workspaces', async (request, reply) => {
    const user = request.user!;
    const workspaces = await WorkspaceService.listUserWorkspaces(user);
    return { data: workspaces };
  });

  // POST /workspaces - Create workspace
  fastify.post('/workspaces', async (request, reply) => {
    const user = request.user!;
    const parsed = createWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    const workspace = await WorkspaceService.createWorkspace(parsed.data, user);
    return reply.status(201).send({ data: workspace });
  });

  // GET /workspaces/:id - Get workspace details
  fastify.get('/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = await WorkspaceService.getWorkspace(id);
    if (!workspace) return reply.status(404).send({ error: 'Workspace não encontrado' });
    return { data: workspace };
  });

  // PUT /workspaces/:id - Update workspace
  fastify.put('/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    const workspace = await WorkspaceService.updateWorkspace(id, parsed.data);
    return { data: workspace };
  });

  // DELETE /workspaces/:id - Delete workspace
  fastify.delete('/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await WorkspaceService.deleteWorkspace(id);
    return { message: 'Workspace excluído com sucesso' };
  });

  // GET /workspaces/:id/members - List members
  fastify.get('/workspaces/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    const members = await WorkspaceService.listMembers(id);
    return { data: members };
  });

  // POST /workspaces/:id/members - Add member
  fastify.post('/workspaces/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.user!;
    const parsed = addMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    const member = await WorkspaceService.addMember(id, parsed.data, actor);
    return reply.status(201).send({ data: member });
  });

  // DELETE /workspaces/:id/members/:memberId - Remove member
  fastify.delete('/workspaces/:id/members/:memberId', async (request, reply) => {
    const { id, memberId } = request.params as { id: string; memberId: string };
    const actor = request.user!;
    await WorkspaceService.removeMember(id, memberId, actor);
    return { message: 'Membro removido com sucesso' };
  });
}
