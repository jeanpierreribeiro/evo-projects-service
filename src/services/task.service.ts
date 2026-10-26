import prisma from '../db/prisma.js';
import { Priority, ApprovalStatus, RelationType } from '@prisma/client';
import { ActivityService } from './activity.service.js';
import { NotificationService } from './notification.service.js';

export class TaskService {
  static async listByProject(projectId: string, filters?: { columnId?: string; assigneeId?: string; priority?: Priority }) {
    const tasks = await prisma.task.findMany({
      where: {
        projectId,
        isArchived: false,
        ...(filters?.columnId ? { columnId: filters.columnId } : {}),
        ...(filters?.assigneeId ? { assigneeId: filters.assigneeId } : {}),
        ...(filters?.priority ? { priority: filters.priority } : {}),
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
      include: {
        subtasks: {
          orderBy: { position: 'asc' },
        },
        column: {
          select: { id: true, name: true, color: true, isDoneColumn: true },
        },
        resources: true,
        relationsFrom: {
          include: {
            relatedTask: {
              select: { id: true, title: true, taskNumber: true, column: true },
            },
          },
        },
        relationsTo: {
          include: {
            task: {
              select: { id: true, title: true, taskNumber: true, column: true },
            },
          },
        },
        _count: {
          select: {
            comments: true,
            subtasks: true,
            timeEntries: true,
          },
        },
      },
    });

    return tasks.map((t) => {
      const completedSubtasks = t.subtasks.filter((s) => s.completed).length;
      const totalSubtasks = t.subtasks.length;
      const subtaskProgress = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

      return {
        ...t,
        completedSubtasks,
        totalSubtasks,
        subtaskProgress,
      };
    });
  }

  static async listMyTasks(workspaceId: string, userId: string) {
    const tasks = await prisma.task.findMany({
      where: {
        workspaceId,
        assigneeId: userId,
        isArchived: false,
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      include: {
        project: {
          select: { id: true, name: true, color: true },
        },
        column: {
          select: { id: true, name: true, color: true, isDoneColumn: true },
        },
        subtasks: true,
        _count: {
          select: { comments: true },
        },
      },
    });

    return tasks;
  }

  static async createTask(
    projectId: string,
    data: {
      title: string;
      description?: string;
      columnId?: string;
      priority?: Priority;
      assigneeId?: string;
      assigneeName?: string;
      assigneeAvatar?: string;
      startDate?: string | Date;
      dueDate?: string | Date;
      estimatedHours?: number;
      tags?: string[];
    },
    actor: { id: string; name: string }
  ) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { columns: { orderBy: { position: 'asc' } } },
    });

    if (!project) throw new Error('Projeto não encontrado');

    const columnId = data.columnId || project.columns[0]?.id;
    if (!columnId) throw new Error('Coluna de destino não encontrada');

    // Get max position in column
    const lastTask = await prisma.task.findFirst({
      where: { projectId, columnId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = lastTask ? lastTask.position + 1 : 0;

    const task = await prisma.task.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        columnId,
        title: data.title,
        description: data.description,
        priority: data.priority || Priority.NONE,
        assigneeId: data.assigneeId,
        assigneeName: data.assigneeName,
        assigneeAvatar: data.assigneeAvatar,
        position,
        startDate: data.startDate ? new Date(data.startDate) : null,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        estimatedHours: data.estimatedHours,
        tags: data.tags || [],
      },
      include: {
        column: true,
        project: { select: { id: true, name: true } },
      },
    });

    await ActivityService.log({
      workspaceId: project.workspaceId,
      projectId,
      taskId: task.id,
      userId: actor.id,
      userName: actor.name,
      action: 'created_task',
      details: { taskTitle: task.title, taskNumber: task.taskNumber },
    });

    if (data.assigneeId && data.assigneeId !== actor.id) {
      await NotificationService.create({
        workspaceId: project.workspaceId,
        userId: data.assigneeId,
        taskId: task.id,
        title: 'Nova tarefa atribuída',
        content: `${actor.name} atribuiu a tarefa #${task.taskNumber} "${task.title}" a você.`,
        type: 'assignment',
      });
    }

    return task;
  }

  static async getTask(id: string) {
    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        project: {
          select: { id: true, name: true, color: true, workspaceId: true },
        },
        column: true,
        subtasks: {
          orderBy: { position: 'asc' },
        },
        resources: {
          orderBy: { createdAt: 'desc' },
        },
        timeEntries: {
          orderBy: { date: 'desc' },
        },
        comments: {
          orderBy: { createdAt: 'desc' },
        },
        relationsFrom: {
          include: {
            relatedTask: {
              select: { id: true, title: true, taskNumber: true, column: true, priority: true },
            },
          },
        },
        relationsTo: {
          include: {
            task: {
              select: { id: true, title: true, taskNumber: true, column: true, priority: true },
            },
          },
        },
        fieldValues: {
          include: {
            field: true,
          },
        },
      },
    });

    return task;
  }

  static async updateTask(
    id: string,
    data: {
      title?: string;
      description?: string;
      columnId?: string;
      priority?: Priority;
      assigneeId?: string | null;
      assigneeName?: string | null;
      assigneeAvatar?: string | null;
      startDate?: string | Date | null;
      dueDate?: string | Date | null;
      estimatedHours?: number | null;
      tags?: string[];
      isArchived?: boolean;
    },
    actor: { id: string; name: string }
  ) {
    const prev = await prisma.task.findUnique({ where: { id } });
    if (!prev) throw new Error('Tarefa não encontrada');

    const updated = await prisma.task.update({
      where: { id },
      data: {
        ...data,
        startDate: data.startDate !== undefined ? (data.startDate ? new Date(data.startDate) : null) : undefined,
        dueDate: data.dueDate !== undefined ? (data.dueDate ? new Date(data.dueDate) : null) : undefined,
      },
      include: {
        column: true,
        project: { select: { id: true, name: true } },
      },
    });

    await ActivityService.log({
      workspaceId: updated.workspaceId,
      projectId: updated.projectId,
      taskId: updated.id,
      userId: actor.id,
      userName: actor.name,
      action: 'updated_task',
      details: { taskTitle: updated.title, changes: data },
    });

    if (data.assigneeId && data.assigneeId !== prev.assigneeId && data.assigneeId !== actor.id) {
      await NotificationService.create({
        workspaceId: updated.workspaceId,
        userId: data.assigneeId,
        taskId: updated.id,
        title: 'Tarefa atribuída',
        content: `${actor.name} atribuiu a tarefa #${updated.taskNumber} "${updated.title}" a você.`,
        type: 'assignment',
      });
    }

    return updated;
  }

  static async moveTask(
    id: string,
    targetColumnId: string,
    targetPosition: number,
    actor: { id: string; name: string }
  ) {
    const task = await prisma.task.findUnique({
      where: { id },
      include: { column: true },
    });
    if (!task) throw new Error('Tarefa não encontrada');

    const oldColumnId = task.columnId;
    const isColumnChange = oldColumnId !== targetColumnId;

    // Shift positions in target column
    await prisma.task.updateMany({
      where: {
        columnId: targetColumnId,
        position: { gte: targetPosition },
      },
      data: {
        position: { increment: 1 },
      },
    });

    const updated = await prisma.task.update({
      where: { id },
      data: {
        columnId: targetColumnId,
        position: targetPosition,
      },
      include: {
        column: true,
      },
    });

    if (isColumnChange) {
      await ActivityService.log({
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        taskId: task.id,
        userId: actor.id,
        userName: actor.name,
        action: 'moved_column',
        details: {
          taskTitle: task.title,
          fromColumn: task.column.name,
          toColumn: updated.column.name,
        },
      });
    }

    return updated;
  }

  static async deleteTask(id: string, actor: { id: string; name: string }) {
    const task = await prisma.task.delete({
      where: { id },
    });

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      userId: actor.id,
      userName: actor.name,
      action: 'deleted_task',
      details: { taskTitle: task.title, taskNumber: task.taskNumber },
    });

    return task;
  }

  // --- Subtasks ---
  static async addSubtask(taskId: string, title: string) {
    const last = await prisma.subtask.findFirst({
      where: { taskId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = last ? last.position + 1 : 0;

    return prisma.subtask.create({
      data: {
        taskId,
        title,
        position,
      },
    });
  }

  static async updateSubtask(id: string, data: { title?: string; completed?: boolean; position?: number }) {
    return prisma.subtask.update({
      where: { id },
      data,
    });
  }

  static async deleteSubtask(id: string) {
    return prisma.subtask.delete({
      where: { id },
    });
  }

  // --- Relations ---
  static async addRelation(taskId: string, relatedTaskId: string, type: RelationType) {
    if (taskId === relatedTaskId) throw new Error('Não é possível criar relação de uma tarefa com ela mesma');
    return prisma.taskRelation.create({
      data: {
        taskId,
        relatedTaskId,
        type,
      },
      include: {
        relatedTask: {
          select: { id: true, title: true, taskNumber: true, column: true },
        },
      },
    });
  }

  static async removeRelation(id: string) {
    return prisma.taskRelation.delete({
      where: { id },
    });
  }

  // --- Resources ---
  static async addResource(taskId: string, data: { title: string; url: string; type?: string }) {
    return prisma.taskResource.create({
      data: {
        taskId,
        title: data.title,
        url: data.url,
        type: data.type || 'other',
      },
    });
  }

  static async removeResource(id: string) {
    return prisma.taskResource.delete({
      where: { id },
    });
  }

  // --- Time Entries ---
  static async addTimeEntry(
    taskId: string,
    data: { description?: string; durationMinutes: number; date?: string | Date },
    user: { id: string; name: string }
  ) {
    return prisma.timeEntry.create({
      data: {
        taskId,
        userId: user.id,
        userName: user.name,
        description: data.description,
        durationMinutes: data.durationMinutes,
        date: data.date ? new Date(data.date) : new Date(),
      },
    });
  }

  static async removeTimeEntry(id: string) {
    return prisma.timeEntry.delete({
      where: { id },
    });
  }

  // --- Comments ---
  static async addComment(
    taskId: string,
    content: string,
    user: { id: string; name: string; avatarUrl?: string }
  ) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { workspaceId: true, projectId: true, assigneeId: true, title: true, taskNumber: true },
    });

    const comment = await prisma.comment.create({
      data: {
        taskId,
        userId: user.id,
        userName: user.name,
        userAvatar: user.avatarUrl,
        content,
      },
    });

    if (task) {
      await ActivityService.log({
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        taskId,
        userId: user.id,
        userName: user.name,
        action: 'added_comment',
        details: { taskTitle: task.title, commentSnippet: content.slice(0, 100) },
      });

      // Notify task assignee if not author
      if (task.assigneeId && task.assigneeId !== user.id) {
        await NotificationService.create({
          workspaceId: task.workspaceId,
          userId: task.assigneeId,
          taskId,
          title: 'Novo comentário na tarefa',
          content: `${user.name} comentou na tarefa #${task.taskNumber} "${task.title}".`,
          type: 'comment',
        });
      }
    }

    return comment;
  }

  static async deleteComment(id: string) {
    return prisma.comment.delete({
      where: { id },
    });
  }
}
