import prisma from '../db/prisma.js';
import { nanoid } from 'nanoid';
import { ApprovalStatus } from '@prisma/client';
import { ActivityService } from './activity.service.js';
import { NotificationService } from './notification.service.js';

export class ApprovalService {
  /**
   * Generates a secure external validation link and 4-digit PIN for a task.
   */
  static async generateLink(taskId: string, actor: { id: string; name: string }) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { project: true },
    });

    if (!task) throw new Error('Tarefa não encontrada');

    const approvalToken = nanoid(20);
    // 4-digit numeric PIN
    const approvalPin = Math.floor(1000 + Math.random() * 9000).toString();

    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        approvalToken,
        approvalPin,
        approvalStatus: ApprovalStatus.PENDING,
        approvalFeedback: null,
      },
    });

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      userId: actor.id,
      userName: actor.name,
      action: 'generated_approval_link',
      details: { taskTitle: task.title, taskNumber: task.taskNumber },
    });

    return {
      taskId: updated.id,
      taskNumber: updated.taskNumber,
      approvalToken,
      approvalPin,
      approvalStatus: updated.approvalStatus,
    };
  }

  /**
   * Public preview without revealing sensitive content before PIN entry.
   */
  static async getPublicPreview(token: string) {
    const task = await prisma.task.findUnique({
      where: { approvalToken: token },
      select: {
        id: true,
        taskNumber: true,
        title: true,
        approvalStatus: true,
        approvedAt: true,
        project: {
          select: { name: true, color: true },
        },
        workspace: {
          select: { name: true, avatarUrl: true },
        },
      },
    });

    if (!task) throw new Error('Link de validação inválido ou expirado');
    return task;
  }

  /**
   * Validates PIN and returns full delivery details.
   */
  static async validatePin(token: string, pin: string) {
    const task = await prisma.task.findUnique({
      where: { approvalToken: token },
      include: {
        project: { select: { name: true, color: true } },
        workspace: { select: { name: true, avatarUrl: true } },
        subtasks: {
          orderBy: { position: 'asc' },
          select: { id: true, title: true, completed: true },
        },
        resources: {
          select: { id: true, title: true, url: true, type: true },
        },
      },
    });

    if (!task) throw new Error('Link de validação inválido');
    if (task.approvalPin !== pin.trim()) {
      throw new Error('Código PIN incorreto');
    }

    return {
      id: task.id,
      taskNumber: task.taskNumber,
      title: task.title,
      description: task.description,
      approvalStatus: task.approvalStatus,
      approvalFeedback: task.approvalFeedback,
      approvedAt: task.approvedAt,
      project: task.project,
      workspace: task.workspace,
      subtasks: task.subtasks,
      resources: task.resources,
    };
  }

  /**
   * Approves delivery. Moves task to done column if exists, logs activity and notifies assignee.
   */
  static async approve(token: string, pin: string, clientIp: string) {
    const task = await prisma.task.findUnique({
      where: { approvalToken: token },
      include: {
        project: {
          include: {
            columns: {
              where: { isDoneColumn: true },
              orderBy: { position: 'desc' },
            },
          },
        },
      },
    });

    if (!task) throw new Error('Link de validação inválido');
    if (task.approvalPin !== pin.trim()) {
      throw new Error('Código PIN incorreto');
    }

    const doneColumn = task.project.columns[0];

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        approvalStatus: ApprovalStatus.APPROVED,
        approvedAt: new Date(),
        approvedIp: clientIp,
        ...(doneColumn ? { columnId: doneColumn.id } : {}),
      },
    });

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      userId: 'client',
      userName: 'Cliente (Portal Externo)',
      action: 'delivery_approved',
      details: {
        taskTitle: task.title,
        taskNumber: task.taskNumber,
        ip: clientIp,
      },
    });

    if (task.assigneeId) {
      await NotificationService.create({
        workspaceId: task.workspaceId,
        userId: task.assigneeId,
        taskId: task.id,
        title: '✅ Entrega Aprovada pelo Cliente!',
        content: `O cliente aprovou a entrega da tarefa #${task.taskNumber} "${task.title}".`,
        type: 'approved',
      });
    }

    return {
      success: true,
      approvalStatus: ApprovalStatus.APPROVED,
      approvedAt: updated.approvedAt,
    };
  }

  /**
   * Requests adjustments with client feedback.
   */
  static async requestChanges(token: string, pin: string, feedback: string, clientIp: string) {
    const task = await prisma.task.findUnique({
      where: { approvalToken: token },
    });

    if (!task) throw new Error('Link de validação inválido');
    if (task.approvalPin !== pin.trim()) {
      throw new Error('Código PIN incorreto');
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        approvalStatus: ApprovalStatus.CHANGES_REQUESTED,
        approvalFeedback: feedback,
      },
    });

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      userId: 'client',
      userName: 'Cliente (Portal Externo)',
      action: 'changes_requested',
      details: {
        taskTitle: task.title,
        taskNumber: task.taskNumber,
        feedback,
        ip: clientIp,
      },
    });

    if (task.assigneeId) {
      await NotificationService.create({
        workspaceId: task.workspaceId,
        userId: task.assigneeId,
        taskId: task.id,
        title: '💬 Ajustes Solicitados pelo Cliente!',
        content: `O cliente solicitou ajustes na tarefa #${task.taskNumber} "${task.title}": "${feedback}"`,
        type: 'changes_requested',
      });
    }

    return {
      success: true,
      approvalStatus: ApprovalStatus.CHANGES_REQUESTED,
      feedback: updated.approvalFeedback,
    };
  }
}
