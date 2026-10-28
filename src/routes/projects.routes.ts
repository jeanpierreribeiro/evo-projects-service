import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProjectService } from '../services/project.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { ValidationError } from '../errors/app-error.js';
import { IdempotencyService } from '../services/idempotency.service.js';

const createProjectSchema = z
  .object({
    name: z.string().min(1, 'Nome do projeto é obrigatório').max(200),
    key: z.string().regex(/^[A-Z0-9]{2,10}$/, 'Chave deve ter entre 2 e 10 caracteres alfanuméricos maiúsculos (ex: PROJ, ALF, DEV)').optional(),
    description: z.string().max(50000).optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    backlogColumnId: z.string().optional(),
  })
  .strict();

const updateProjectSchema = createProjectSchema
  .partial()
  .extend({
    isArchived: z.boolean().optional(),
  })
  .strict();

export async function projectsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /workspaces/:workspaceId/projects - List workspace projects
  fastify.get(
    '/workspaces/:workspaceId/projects',
    {
      config: {
        policy: {
          action: 'read_project',
          resource: 'project',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const { includeArchived, cursor, limit } = request.query as any;
      const actor = request.actor!;

      return ProjectService.listByWorkspace(
        workspaceId,
        actor,
        includeArchived === 'true',
        { cursor, limit }
      );
    }
  );

  // POST /workspaces/:workspaceId/projects - Create project
  fastify.post(
    '/workspaces/:workspaceId/projects',
    {
      config: {
        policy: {
          action: 'create_project',
          resource: 'project',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const actor = request.actor!;
      const idempotencyKey = (request.headers['idempotency-key'] as string) || undefined;

      const parsed = createProjectSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
      }

      if (idempotencyKey) {
        const scopeKey = IdempotencyService.buildScopeKey(
          actor.id,
          workspaceId,
          'create_project',
          idempotencyKey
        );

        const result = await IdempotencyService.runIdempotent(scopeKey, parsed.data, async () => {
          const project = await ProjectService.createProject(workspaceId, parsed.data, actor);
          return { statusCode: 201, result: { data: project } };
        });

        return reply.status(result.statusCode).send(result.result);
      }

      const project = await ProjectService.createProject(workspaceId, parsed.data, actor);
      return reply.status(201).send({ data: project });
    }
  );

  // GET /projects/:id - Get project details
  fastify.get(
    '/projects/:id',
    {
      config: {
        policy: {
          action: 'read_project',
          resource: 'project',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;
      const project = await ProjectService.getProject(id, actor);
      return { data: project };
    }
  );

  // PUT /projects/:id - Update project
  const updateProjectHandler = async (request: any) => {
    const { id } = request.params as { id: string };
    const actor = request.actor!;

    const parsed = updateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message || 'Dados inválidos');
    }

    const project = await ProjectService.updateProject(id, parsed.data, actor);
    return { data: project };
  };

  fastify.put(
    '/projects/:id',
    {
      config: {
        policy: {
          action: 'manage_project',
          resource: 'project',
          minRole: 'ADMIN',
        },
      },
    },
    updateProjectHandler
  );

  fastify.patch(
    '/projects/:id',
    {
      config: {
        policy: {
          action: 'manage_project',
          resource: 'project',
          minRole: 'ADMIN',
        },
      },
    },
    updateProjectHandler
  );

  // DELETE /projects/:id - Delete project (soft-delete)
  fastify.delete(
    '/projects/:id',
    {
      config: {
        policy: {
          action: 'delete_project',
          resource: 'project',
          minRole: 'ADMIN',
          sensitive: true,
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;
      const { reason } = (request.body as any) || {};

      const project = await ProjectService.deleteProject(id, actor, reason);
      return { message: 'Projeto excluído com sucesso', data: project };
    }
  );

  // POST /projects/:id/archive - Archive project (ADMIN)
  fastify.post(
    '/projects/:id/archive',
    {
      config: {
        policy: {
          action: 'archive_project',
          resource: 'project',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const project = await ProjectService.archiveProject(id, actor);
      return { data: project };
    }
  );

  // POST /projects/:id/restore - Restore project (ADMIN)
  fastify.post(
    '/projects/:id/restore',
    {
      config: {
        policy: {
          action: 'restore_project',
          resource: 'project',
          minRole: 'ADMIN',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      const project = await ProjectService.restoreProject(id, actor);
      return { data: project };
    }
  );
}
