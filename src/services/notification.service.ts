import prisma from '../db/prisma.js';
import { AccessService } from './access.service.js';
import { Actor } from '../types/auth.js';
import { NotFoundError } from '../errors/app-error.js';
import { parsePaginationParams, buildCursorResponse } from '../utils/pagination.js';

export class NotificationService {
  /**
   * Cria ou deduplica uma notificação (E3.6-b).
   * - Não notifica o autor da ação (`actorId === userId`).
   * - Deduplica por `dedupKey` através da constraint única `[workspaceId, userId, dedupKey]`.
   */
  static async create(data: {
    workspaceId: string;
    userId: string;
    taskId?: string;
    title: string;
    content: string;
    type?: string;
    dedupKey?: string;
    actorId?: string;
  }) {
    // Não notificar o próprio autor da ação
    if (data.actorId && data.actorId === data.userId) {
      return null;
    }

    try {
      if (data.dedupKey) {
        return await prisma.notification.upsert({
          where: {
            workspaceId_userId_dedupKey: {
              workspaceId: data.workspaceId,
              userId: data.userId,
              dedupKey: data.dedupKey,
            },
          },
          create: {
            workspaceId: data.workspaceId,
            userId: data.userId,
            taskId: data.taskId,
            title: data.title,
            content: data.content,
            type: data.type || 'task',
            dedupKey: data.dedupKey,
            isRead: false,
          },
          update: {
            title: data.title,
            content: data.content,
            taskId: data.taskId,
            type: data.type || 'task',
            isRead: false,
            archivedAt: null,
            createdAt: new Date(),
          },
        });
      }

      return await prisma.notification.create({
        data: {
          workspaceId: data.workspaceId,
          userId: data.userId,
          taskId: data.taskId,
          title: data.title,
          content: data.content,
          type: data.type || 'task',
        },
      });
    } catch (error) {
      console.error('Failed to create notification:', error);
      return null;
    }
  }

  static async notifyWorkspaceAdmins(data: {
    workspaceId: string;
    taskId?: string;
    title: string;
    content: string;
    type?: string;
    actorId?: string;
  }) {
    try {
      const admins = await prisma.workspaceMember.findMany({
        where: {
          workspaceId: data.workspaceId,
          role: 'ADMIN',
          status: 'ACTIVE',
        },
        select: { userId: true },
      });

      for (const admin of admins) {
        if (data.actorId && admin.userId === data.actorId) {
          continue;
        }
        await this.create({
          workspaceId: data.workspaceId,
          userId: admin.userId,
          taskId: data.taskId,
          title: data.title,
          content: data.content,
          type: data.type || 'security_alert',
          actorId: data.actorId,
        });
      }
    } catch (err) {
      // Falha silenciosa em alertas de segundo plano
    }
  }

  static async listByUser(
    workspaceId: string,
    actor: Actor,
    paginationQuery: {
      cursor?: string;
      limit?: string | number;
      archived?: string | boolean;
      includeArchived?: string | boolean;
      unreadOnly?: string | boolean;
    } = {}
  ) {
    await AccessService.assertCan(actor, 'read_own_notifications', {
      workspaceId,
      targetUserId: actor.id,
    });

    const { cursor, limit } = parsePaginationParams(paginationQuery);

    const whereClause: any = {
      workspaceId,
      userId: actor.id,
    };

    if (paginationQuery.unreadOnly === true || paginationQuery.unreadOnly === 'true') {
      whereClause.isRead = false;
    }

    if (paginationQuery.archived === true || paginationQuery.archived === 'true') {
      whereClause.archivedAt = { not: null };
    } else if (
      paginationQuery.includeArchived !== true &&
      paginationQuery.includeArchived !== 'true'
    ) {
      // Por padrão, esconde arquivadas
      whereClause.archivedAt = null;
    }

    const notifications = await prisma.notification.findMany({
      where: whereClause,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      include: {
        task: {
          select: { id: true, title: true, taskNumber: true, projectId: true },
        },
      },
    });

    return buildCursorResponse(notifications, limit);
  }

  static async markAsRead(id: string, actor: Actor) {
    const notification = await prisma.notification.findUnique({
      where: { id },
    });

    if (!notification || notification.userId !== actor.id) {
      // 404 para isolamento e não revelar notificações de outros usuários (E1.4-d)
      throw new NotFoundError('Notificação não encontrada.');
    }

    await AccessService.assertCan(actor, 'manage_own_notifications', {
      workspaceId: notification.workspaceId,
      targetUserId: actor.id,
    });

    return prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  static async archive(id: string, actor: Actor) {
    const notification = await prisma.notification.findUnique({
      where: { id },
    });

    if (!notification || notification.userId !== actor.id) {
      throw new NotFoundError('Notificação não encontrada.');
    }

    await AccessService.assertCan(actor, 'manage_own_notifications', {
      workspaceId: notification.workspaceId,
      targetUserId: actor.id,
    });

    return prisma.notification.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
  }

  static async unarchive(id: string, actor: Actor) {
    const notification = await prisma.notification.findUnique({
      where: { id },
    });

    if (!notification || notification.userId !== actor.id) {
      throw new NotFoundError('Notificação não encontrada.');
    }

    await AccessService.assertCan(actor, 'manage_own_notifications', {
      workspaceId: notification.workspaceId,
      targetUserId: actor.id,
    });

    return prisma.notification.update({
      where: { id },
      data: { archivedAt: null },
    });
  }

  static async markAllAsRead(workspaceId: string, actor: Actor) {
    await AccessService.assertCan(actor, 'manage_own_notifications', {
      workspaceId,
      targetUserId: actor.id,
    });

    return prisma.notification.updateMany({
      where: { workspaceId, userId: actor.id, isRead: false },
      data: { isRead: true },
    });
  }
}
