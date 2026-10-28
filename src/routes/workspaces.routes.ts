import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspace.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { WorkspaceRole } from '@prisma/client';
import { ValidationError } from '../errors/app-error.js';

const createWorkspaceSchema = z
  .object({
    name: z.string().min(1, 'Nome é obrigatório').max(200),
    description: z.string().max(5000).optional(),
    color: z.string().optional(),
    avatarUrl: z.string().url().optional(),
    timezone: z.string().max(100).optional(),
  })
  .strict();

const updateWorkspaceSchema = createWorkspaceSchema.partial().strict();

const addMemberSchema = z
  .object({
    userId: z.string().min(1, 'userId é obrigatório'),
    email: z.string().email('Email inválido'),
    name: z.string().min(1, 'Nome é obrigatório').max(200),
    role: z.nativeEnum(WorkspaceRole).optional(),
    avatarUrl: z.string().url().optional(),
  })
  .strict();

export async function workspacesRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /workspaces - List user's workspaces
  fastify.get(
    '/workspaces',
    {
      config: {
        policy: {
          action: 'list_workspaces',
          resource: 'workspace',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const actor = request.actor!;
      const workspaces = await WorkspaceService.listUserWorkspaces(actor);
      return { data: workspaces };
    }
  );

  // POST /workspaces - Create workspace (explícito e idempotente)
  fastify.post(
    '/workspaces',
    {
      config: {
        policy: {
          action: 'create_workspace',
          resource: 'workspace',
          sensitive: true,
        },
      },
    },
    async (request, reply) => {
      const actor = request.actor!;
      const parsed = createWorkspaceSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const workspace = await WorkspaceService.createWorkspace(parsed.data, actor);
      return reply.status(201).send({ data: workspace });
    }
  );

  // GET /workspaces/:id - Get workspace details
  fastify.get(
    '/workspaces/:id',
    {
      config: {
        policy: {
          action: 'read_workspace',
          resource: 'workspace',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;
      const workspace = await WorkspaceService.getWorkspace(id, actor);
      return { data: workspace };
    }
  );

  // PUT /workspaces/:id - Update workspace
  fastify.put(
    '/workspaces/:id',
    {
      config: {
        policy: {
          action: 'manage_workspace',
          resource: 'workspace',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;
      const parsed = updateWorkspaceSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const workspace = await WorkspaceService.updateWorkspace(id, parsed.data, actor);
      return { data: workspace };
    }
  );

  // DELETE /workspaces/:id - Delete workspace (soft-delete)
  fastify.delete(
    '/workspaces/:id',
    {
      config: {
        policy: {
          action: 'delete_workspace',
          resource: 'workspace',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;
      const { reason } = (request.body as any) || {};

      const workspace = await WorkspaceService.deleteWorkspace(id, actor, reason);
      return { message: 'Workspace excluído com sucesso', data: workspace };
    }
  );

  // POST /workspaces/:id/archive - Archive workspace (ADMIN)
  fastify.post(
    '/workspaces/:id/archive',
    {
      config: {
        policy: {
          action: 'archive_workspace',
          resource: 'workspace',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const workspace = await WorkspaceService.archiveWorkspace(id, actor);
      return { data: workspace };
    }
  );

  // POST /workspaces/:id/restore - Restore workspace (ADMIN)
  fastify.post(
    '/workspaces/:id/restore',
    {
      config: {
        policy: {
          action: 'restore_workspace',
          resource: 'workspace',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const workspace = await WorkspaceService.restoreWorkspace(id, actor);
      return { data: workspace };
    }
  );

  // GET /workspaces/:id/members - List members
  fastify.get(
    '/workspaces/:id/members',
    {
      config: {
        policy: {
          action: 'read_workspace',
          resource: 'workspace_members',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as any;
      const actor = request.actor!;
      return WorkspaceService.listMembers(id, actor, query);
    }
  );

  // POST /workspaces/:id/members - Add member
  fastify.post(
    '/workspaces/:id/members',
    {
      config: {
        policy: {
          action: 'manage_members',
          resource: 'workspace_members',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;
      const parsed = addMemberSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      const member = await WorkspaceService.addMember(id, parsed.data, actor);
      return reply.status(201).send({ data: member });
    }
  );

  // PATCH /workspaces/:id/members/:memberId - Update member role (E3.5-f)
  const updateMemberRoleSchema = z
    .object({
      role: z.nativeEnum(WorkspaceRole),
    })
    .strict();

  fastify.patch(
    '/workspaces/:id/members/:memberId',
    {
      config: {
        policy: {
          action: 'manage_members',
          resource: 'workspace_members',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request) => {
      const { id, memberId } = request.params as { id: string; memberId: string };
      const actor = request.actor!;
      const parsed = updateMemberRoleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Papel de membro inválido.');
      }
      const member = await WorkspaceService.updateMemberRole(id, memberId, parsed.data.role, actor);
      return { data: member };
    }
  );

  // DELETE /workspaces/:id/members/:memberId - Remove member
  fastify.delete(
    '/workspaces/:id/members/:memberId',
    {
      config: {
        policy: {
          action: 'manage_members',
          resource: 'workspace_members',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request) => {
      const { id, memberId } = request.params as { id: string; memberId: string };
      const actor = request.actor!;
      await WorkspaceService.removeMember(id, memberId, actor);
      return { message: 'Membro removido com sucesso' };
    }
  );
}
