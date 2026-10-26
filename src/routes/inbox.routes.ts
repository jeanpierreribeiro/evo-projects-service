import { FastifyInstance } from 'fastify';
import { NotificationService } from '../services/notification.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

export async function inboxRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // GET /workspaces/:workspaceId/inbox - List user's notifications
  fastify.get('/workspaces/:workspaceId/inbox', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const user = request.user!;

    const notifications = await NotificationService.listByUser(workspaceId, user.id);
    return { data: notifications };
  });

  // PATCH /inbox/:id/read - Mark notification as read
  fastify.patch('/inbox/:id/read', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    await NotificationService.markAsRead(id, user.id);
    return { success: true };
  });

  // POST /workspaces/:workspaceId/inbox/mark-all-read - Mark all as read
  fastify.post('/workspaces/:workspaceId/inbox/mark-all-read', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const user = request.user!;

    await NotificationService.markAllAsRead(workspaceId, user.id);
    return { success: true };
  });
}
