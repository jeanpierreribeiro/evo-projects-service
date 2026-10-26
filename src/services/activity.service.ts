import prisma from '../db/prisma.js';

export class ActivityService {
  static async log(data: {
    workspaceId: string;
    projectId?: string;
    taskId?: string;
    userId: string;
    userName: string;
    action: string;
    details?: any;
  }) {
    try {
      return await prisma.activity.create({
        data: {
          workspaceId: data.workspaceId,
          projectId: data.projectId,
          taskId: data.taskId,
          userId: data.userId,
          userName: data.userName,
          action: data.action,
          details: data.details,
        },
      });
    } catch (error) {
      console.error('Failed to log activity:', error);
      return null;
    }
  }

  static async listByWorkspace(workspaceId: string, limit = 20) {
    return prisma.activity.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        task: {
          select: { id: true, title: true, taskNumber: true },
        },
        project: {
          select: { id: true, name: true, color: true },
        },
      },
    });
  }
}
