import { FastifyInstance } from 'fastify';
import { NotificationService } from '../services/notification.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

export async function inboxRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /workspaces/:workspaceId/inbox - List user's notifications (privado do operador)
  fastify.get(
    '/workspaces/:workspaceId/inbox',
    {
      config: {
        policy: {
          action: 'read_own_notifications',
          resource: 'notification',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const query = request.query as any;
      const actor = request.actor!;

      return NotificationService.listByUser(workspaceId, actor, query);
    }
  );

  // PATCH /inbox/:id/read - Mark notification as read (apenas a própria)
  fastify.patch(
    '/inbox/:id/read',
    {
      config: {
        policy: {
          action: 'manage_own_notifications',
          resource: 'notification',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      await NotificationService.markAsRead(id, actor);
      return { success: true };
    }
  );

  // PATCH /inbox/:id/archive - Archive notification (E3.6-b)
  fastify.patch(
    '/inbox/:id/archive',
    {
      config: {
        policy: {
          action: 'manage_own_notifications',
          resource: 'notification',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      await NotificationService.archive(id, actor);
      return { success: true };
    }
  );

  // PATCH /inbox/:id/unarchive - Unarchive notification (E3.6-b)
  fastify.patch(
    '/inbox/:id/unarchive',
    {
      config: {
        policy: {
          action: 'manage_own_notifications',
          resource: 'notification',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = request.actor!;

      await NotificationService.unarchive(id, actor);
      return { success: true };
    }
  );

  // POST /workspaces/:workspaceId/inbox/mark-all-read - Mark all as read (apenas as próprias)
  fastify.post(
    '/workspaces/:workspaceId/inbox/mark-all-read',
    {
      config: {
        policy: {
          action: 'manage_own_notifications',
          resource: 'notification',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const actor = request.actor!;

      await NotificationService.markAllAsRead(workspaceId, actor);
      return { success: true };
    }
  );

  // PUT /workspaces/:workspaceId/inbox/mark-all-read - Mark all as read (idempotente)
  fastify.put(
    '/workspaces/:workspaceId/inbox/mark-all-read',
    {
      config: {
        policy: {
          action: 'manage_own_notifications',
          resource: 'notification',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const actor = request.actor!;

      await NotificationService.markAllAsRead(workspaceId, actor);
      return { success: true };
    }
  );
}
