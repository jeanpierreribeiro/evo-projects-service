import prisma from '../db/prisma.js';

export class NotificationService {
  static async create(data: {
    workspaceId: string;
    userId: string;
    taskId?: string;
    title: string;
    content: string;
    type?: string;
  }) {
    try {
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

  static async listByUser(workspaceId: string, userId: string) {
    return prisma.notification.findMany({
      where: {
        workspaceId,
        userId,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        task: {
          select: { id: true, title: true, taskNumber: true, projectId: true },
        },
      },
    });
  }

  static async markAsRead(id: string, userId: string) {
    return prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
  }

  static async markAllAsRead(workspaceId: string, userId: string) {
    return prisma.notification.updateMany({
      where: { workspaceId, userId, isRead: false },
      data: { isRead: true },
    });
  }
}
