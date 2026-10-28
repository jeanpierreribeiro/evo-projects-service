import prisma from '../db/prisma.js';
import { Priority, ApprovalStatus, RelationType } from '@prisma/client';
import { ActivityService } from './activity.service.js';
import { NotificationService } from './notification.service.js';
import { AccessService } from './access.service.js';
import { ShareService } from './share.service.js';
import { Actor } from '../types/auth.js';
import { NotFoundError, ValidationError, VersionConflictError, ConflictError } from '../errors/app-error.js';
import {
  toTaskInternalDTO,
  toTaskInternalListDTO,
  sanitizeTaskDTO,
  sanitizeTaskListDTO,
  toTaskCustomerAgentDTO,
  toTaskCustomerAgentListDTO,
  TaskCustomerAgentDTO,
} from '../dto/task-dto.js';
import { parsePaginationParams, buildCursorResponse, PaginationResult } from '../utils/pagination.js';
import { parseCivilDate, formatCivilDate } from '../utils/dates.js';
import { withProjectLock, withColumnsLock, withTransaction } from '../db/tx.js';
import { wouldCreateBlockCycle } from '../utils/cycles.js';

export class TaskService {
  static async listByProject(
    projectId: string,
    actor: Actor,
    filters?: {
      columnId?: string;
      assigneeId?: string;
      priority?: Priority;
      startDate?: string;
      dueDate?: string;
      cursor?: string;
      limit?: number | string;
      includeArchived?: boolean;
    }
  ) {
    const project = await AccessService.getAuthorizedProject(projectId, actor, 'read_project');
    const { cursor, limit } = parsePaginationParams(filters);

    const where: any = {
      projectId: project.id,
      deletedAt: null,
      ...(filters?.includeArchived ? {} : { isArchived: false }),
      ...(filters?.columnId ? { columnId: filters.columnId } : {}),
      ...(filters?.assigneeId ? { assigneeId: filters.assigneeId } : {}),
      ...(filters?.priority ? { priority: filters.priority } : {}),
    };

    if (filters?.startDate) {
      where.startDate = { gte: new Date(filters.startDate) };
    }
    if (filters?.dueDate) {
      where.dueDate = { lte: new Date(filters.dueDate) };
    }

    const tasks = await prisma.task.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      include: {
        project: {
          select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true },
        },
        labels: {
          include: { label: true },
        },
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

    const mappedTasks = toTaskInternalListDTO(
      tasks.map((t) => {
        const completedSubtasks = t.subtasks.filter((s) => s.completed).length;
        const totalSubtasks = t.subtasks.length;
        const subtaskProgress = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

        return {
          ...t,
          completedSubtasks,
          totalSubtasks,
          subtaskProgress,
        };
      })
    );

    return buildCursorResponse(mappedTasks, limit);
  }

  static async listMyTasks(
    workspaceId: string,
    actor: Actor,
    options?: { cursor?: string; limit?: number | string }
  ) {
    await AccessService.assertCan(actor, 'read_task', { workspaceId });
    const { cursor, limit } = parsePaginationParams(options);

    const tasks = await prisma.task.findMany({
      where: {
        workspaceId,
        assigneeId: actor.id,
        isArchived: false,
      },
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      include: {
        project: {
          select: { id: true, name: true, key: true, color: true },
        },
        labels: {
          include: { label: true },
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

    return buildCursorResponse(toTaskInternalListDTO(tasks), limit);
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
      startDate?: string;
      dueDate?: string;
      estimatedMinutes?: number;
      estimatedHours?: number;
      tags?: string[];
      crmContext?: {
        crmInstanceId: string;
        crmContactId?: string | null;
        crmConversationId?: string | null;
        metadata?: any;
      };
    },
    actor: Actor
  ) {
    const project = await AccessService.getAuthorizedProject(projectId, actor, 'create_task');

    // Valida datas civis e consistência de intervalo (I4 / 3.2-a)
    const startDate = data.startDate ? parseCivilDate(data.startDate) : null;
    const dueDate = data.dueDate ? parseCivilDate(data.dueDate) : null;
    if (startDate && dueDate && startDate > dueDate) {
      throw new ValidationError('A data de início não pode ser posterior à data de vencimento.');
    }

    // Valida estimativa em minutos (I6 / 3.2-c)
    let estimatedMinutes: number | null = null;
    if (data.estimatedMinutes !== undefined) {
      estimatedMinutes = data.estimatedMinutes;
    } else if (data.estimatedHours !== undefined) {
      estimatedMinutes = Math.round(data.estimatedHours * 60);
    }
    if (estimatedMinutes !== null && estimatedMinutes <= 0) {
      throw new ValidationError('A estimativa em minutos deve ser maior que zero.');
    }

    // Valida responsável ativo (I3 / 3.4-b)
    let assigneeId: string | null = null;
    let assigneeName: string | null = null;
    let assigneeAvatar: string | null = null;
    if (data.assigneeId) {
      const member = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: project.workspaceId,
            userId: data.assigneeId,
          },
        },
      });
      if (!member || member.status !== 'ACTIVE') {
        throw new ValidationError('O responsável informado deve ser um membro ativo do workspace.');
      }
      assigneeId = member.userId;
      assigneeName = member.name;
      assigneeAvatar = member.avatarUrl;
    }

    // Se informada a coluna, valida que pertence ao projeto
    let columnId = data.columnId;
    if (columnId) {
      await AccessService.getAuthorizedColumn(columnId, actor, 'create_task', project.id);
    } else {
      const firstCol = await prisma.column.findFirst({
        where: { projectId: project.id },
        orderBy: { position: 'asc' },
      });
      if (!firstCol) throw new NotFoundError('Projeto não possui colunas configuradas.');
      columnId = firstCol.id;
    }

    // Executa em transação para alocação atômica de taskNumber sequencial por projeto (E3.3-c / T12)
    const task = await prisma.$transaction(async (tx) => {
      // 1. Incrementa atomicamente o contador do projeto
      const proj = await tx.project.update({
        where: { id: project.id },
        data: { taskCounter: { increment: 1 } },
        select: { id: true, key: true, taskCounter: true },
      });
      const taskNumber = proj.taskCounter;

      // 2. Calcula a próxima posição dentro da coluna
      const lastTask = await tx.task.findFirst({
        where: { projectId: project.id, columnId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const position = lastTask ? lastTask.position + 1 : 0;

      // 3. Cria a tarefa
      const created = await tx.task.create({
        data: {
          taskNumber,
          workspaceId: project.workspaceId,
          projectId: project.id,
          columnId,
          title: data.title,
          description: data.description,
          priority: data.priority || Priority.NONE,
          assigneeId,
          assigneeName,
          assigneeAvatar,
          position,
          startDate,
          dueDate,
          estimatedMinutes,
          tags: data.tags || [],
          version: 1,
        },
      });

      // 4. Sincroniza etiquetas (Label e TaskLabel - E3.3-a)
      if (data.tags && data.tags.length > 0) {
        for (const rawTag of data.tags) {
          const trimmed = rawTag.trim();
          const normalizedName = trimmed.toLowerCase();
          if (!normalizedName) continue;

          let label = await tx.label.findUnique({
            where: {
              workspaceId_normalizedName: {
                workspaceId: project.workspaceId,
                normalizedName,
              },
            },
          });
          if (!label) {
            label = await tx.label.create({
              data: {
                workspaceId: project.workspaceId,
                name: trimmed,
                normalizedName,
                color: '#64748b',
              },
            });
          }

          await tx.taskLabel.create({
            data: {
              taskId: created.id,
              labelId: label.id,
            },
          });
        }
      }

      // 5. Registra vínculo CRM se fornecido contexto autenticado (E4.2-b)
      if (data.crmContext?.crmInstanceId) {
        const crmContactId = data.crmContext.crmContactId?.trim();
        if (!crmContactId) {
          throw new ValidationError('crmContactId é obrigatório para vínculo CRM da tarefa.');
        }
        await tx.taskCrmLink.create({
          data: {
            taskId: created.id,
            crmInstanceId: data.crmContext.crmInstanceId.trim(),
            crmContactId,
            crmConversationId: data.crmContext.crmConversationId?.trim() || null,
          },
        });
      }

      const fullTask = await tx.task.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          column: true,
          project: { select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true } },
          labels: { include: { label: true } },
        },
      });

      // Auditoria transacional (E3.5-c)
      await ActivityService.log(
        {
          workspaceId: project.workspaceId,
          projectId: project.id,
          taskId: fullTask.id,
          userId: actor.id,
          userName: (actor as any).name || 'Usuário',
          action: 'created_task',
          details: { title: fullTask.title, taskNumber: fullTask.taskNumber },
        },
        tx
      );

      return fullTask;
    });

    return toTaskInternalDTO(task);
  }

  static async getTask(id: string, actor: Actor) {
    const authorized = await AccessService.getAuthorizedTask(id, actor, 'read_task');

    const task = await prisma.task.findUnique({
      where: { id: authorized.id },
      include: {
        project: {
          select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true },
        },
        labels: {
          include: { label: true },
        },
        column: {
          select: { id: true, name: true, color: true, isDoneColumn: true },
        },
        subtasks: {
          orderBy: { position: 'asc' },
        },
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
        resources: {
          orderBy: { createdAt: 'desc' },
        },
        timeEntries: {
          orderBy: { createdAt: 'desc' },
        },
        comments: {
          orderBy: { createdAt: 'asc' },
        },
        fieldValues: {
          include: { field: true },
        },
      },
    });

    return toTaskInternalDTO(task);
  }

  static async updateTask(
    id: string,
    data: {
      title?: string;
      description?: string | null;
      columnId?: string;
      priority?: Priority;
      assigneeId?: string | null;
      assigneeName?: string | null;
      assigneeAvatar?: string | null;
      startDate?: string | null;
      dueDate?: string | null;
      estimatedMinutes?: number | null;
      estimatedHours?: number | null;
      tags?: string[];
      isArchived?: boolean;
      expectedVersion?: number;
    },
    actor: Actor
  ) {
    const existing = await AccessService.getAuthorizedTask(id, actor, 'edit_task');

    // Validação de concorrência com versão esperada (E3.1-a / T11)
    if (data.expectedVersion !== undefined && data.expectedVersion !== existing.version) {
      throw new VersionConflictError(
        `Conflito de versão ao atualizar tarefa. Versão enviada: ${data.expectedVersion}, versão atual: ${existing.version}.`,
        existing.version
      );
    }

    // Valida coluna se alterada
    if (data.columnId && data.columnId !== existing.columnId) {
      await AccessService.getAuthorizedColumn(data.columnId, actor, 'edit_task', existing.projectId);
    }

    // Semântica de atualização parcial (E3.1-b):
    // campo ausente mantém; null limpa campo anulável; string vazia não substitui null
    const updateData: any = {
      version: { increment: 1 },
    };

    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.columnId !== undefined) updateData.columnId = data.columnId;
    if (data.priority !== undefined) updateData.priority = data.priority;
    if (data.assigneeId !== undefined) {
      if (data.assigneeId === null) {
        updateData.assigneeId = null;
        updateData.assigneeName = null;
        updateData.assigneeAvatar = null;
      } else {
        const member = await prisma.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: existing.workspaceId,
              userId: data.assigneeId,
            },
          },
        });
        if (!member || member.status !== 'ACTIVE') {
          throw new ValidationError('O responsável informado deve ser um membro ativo do workspace.');
        }
        updateData.assigneeId = member.userId;
        updateData.assigneeName = member.name;
        updateData.assigneeAvatar = member.avatarUrl;
      }
    }

    // Datas civis e intervalo (I4 / 3.2-a)
    if (data.startDate !== undefined) {
      updateData.startDate = parseCivilDate(data.startDate);
    }
    if (data.dueDate !== undefined) {
      updateData.dueDate = parseCivilDate(data.dueDate);
    }

    const effectiveStart = data.startDate !== undefined ? updateData.startDate : existing.startDate;
    const effectiveDue = data.dueDate !== undefined ? updateData.dueDate : existing.dueDate;
    if (effectiveStart && effectiveDue && effectiveStart > effectiveDue) {
      throw new ValidationError('A data de início não pode ser posterior à data de vencimento.');
    }

    // Estimativas em minutos (I6 / 3.2-c)
    if (data.estimatedMinutes !== undefined) {
      if (data.estimatedMinutes !== null && data.estimatedMinutes <= 0) {
        throw new ValidationError('A estimativa em minutos deve ser maior que zero.');
      }
      updateData.estimatedMinutes = data.estimatedMinutes;
    } else if (data.estimatedHours !== undefined) {
      if (data.estimatedHours !== null && data.estimatedHours <= 0) {
        throw new ValidationError('A estimativa em horas deve ser maior que zero.');
      }
      updateData.estimatedMinutes = data.estimatedHours !== null ? Math.round(data.estimatedHours * 60) : null;
    }

    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.isArchived !== undefined) updateData.isArchived = data.isArchived;

    const whereClause: any = { id: existing.id };
    if (data.expectedVersion !== undefined) {
      whereClause.version = data.expectedVersion;
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const task = await tx.task.update({
          where: whereClause,
          data: updateData,
        });

        // Sincroniza etiquetas (Label e TaskLabel) se tags forem fornecidas
        if (data.tags !== undefined) {
          await tx.taskLabel.deleteMany({
            where: { taskId: existing.id },
          });

          for (const rawTag of data.tags) {
            const trimmed = rawTag.trim();
            const normalizedName = trimmed.toLowerCase();
            if (!normalizedName) continue;

            let label = await tx.label.findUnique({
              where: {
                workspaceId_normalizedName: {
                  workspaceId: existing.workspaceId,
                  normalizedName,
                },
              },
            });
            if (!label) {
              label = await tx.label.create({
                data: {
                  workspaceId: existing.workspaceId,
                  name: trimmed,
                  normalizedName,
                  color: '#64748b',
                },
              });
            }

            await tx.taskLabel.create({
              data: {
                taskId: existing.id,
                labelId: label.id,
              },
            });
          }
        }

        const fullTask = await tx.task.findUniqueOrThrow({
          where: { id: existing.id },
          include: {
            column: true,
            project: { select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true } },
            labels: { include: { label: true } },
          },
        });

        // Auditoria transacional (E3.5-c)
        await ActivityService.log(
          {
            workspaceId: existing.workspaceId,
            projectId: existing.projectId,
            taskId: existing.id,
            userId: actor.id,
            userName: (actor as any).name || 'Usuário',
            action: 'updated_task',
            details: { title: fullTask.title, version: fullTask.version },
          },
          tx
        );

        return fullTask;
      });

      await ShareService.touchPublicContent(existing.id);

      return toTaskInternalDTO(updated);
    } catch (err: any) {
      if (err.code === 'P2025') {
        const current = await prisma.task.findUnique({
          where: { id: existing.id },
          select: { version: true },
        });
        throw new VersionConflictError(
          `Conflito de versão ao atualizar tarefa. O registro foi modificado concorrentemente.`,
          current?.version
        );
      }
      throw err;
    }
  }

  static async moveTask(id: string, targetColumnId: string, targetPosition: number, actor: Actor) {
    const existing = await AccessService.getAuthorizedTask(id, actor, 'move_task');

    // Valida que a coluna destino pertence ao mesmo projeto
    await AccessService.getAuthorizedColumn(targetColumnId, actor, 'move_task', existing.projectId);

    // E3.5-b: Bloqueia colunas em ordem determinística para eliminar deadlocks entre movimentos concorrentes
    const updated = await withColumnsLock(
      [existing.columnId, targetColumnId],
      async (tx) => {
        const isSameColumn = existing.columnId === targetColumnId;

        if (isSameColumn) {
          // Reordenação na mesma coluna
          const currentTasks = await tx.task.findMany({
            where: { columnId: existing.columnId },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          });

          const withoutMoving = currentTasks.filter((t) => t.id !== existing.id);
          const movingTask = currentTasks.find((t) => t.id === existing.id);
          const clampedPos = Math.max(0, Math.min(targetPosition, withoutMoving.length));

          if (movingTask) {
            withoutMoving.splice(clampedPos, 0, movingTask);
          }

          for (let i = 0; i < withoutMoving.length; i++) {
            const t = withoutMoving[i];
            const isMoving = t.id === existing.id;
            if (t.position !== i || isMoving) {
              await tx.task.update({
                where: { id: t.id },
                data: {
                  position: i,
                  ...(isMoving ? { version: { increment: 1 } } : {}),
                },
              });
            }
          }

          // Atualiza orderVersion da coluna
          await tx.column.update({
            where: { id: existing.columnId },
            data: { orderVersion: { increment: 1 } },
          });
        } else {
          // Movimento entre colunas distintas
          // 1. Reordena coluna de origem
          const sourceTasks = await tx.task.findMany({
            where: { columnId: existing.columnId, id: { not: existing.id } },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          });
          for (let i = 0; i < sourceTasks.length; i++) {
            if (sourceTasks[i].position !== i) {
              await tx.task.update({
                where: { id: sourceTasks[i].id },
                data: { position: i },
              });
            }
          }

          // 2. Reordena coluna de destino
          const targetTasks = await tx.task.findMany({
            where: { columnId: targetColumnId },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          });
          const clampedPos = Math.max(0, Math.min(targetPosition, targetTasks.length));

          for (let i = clampedPos; i < targetTasks.length; i++) {
            await tx.task.update({
              where: { id: targetTasks[i].id },
              data: { position: i + 1 },
            });
          }

          // Atualiza a tarefa movida
          await tx.task.update({
            where: { id: existing.id },
            data: {
              columnId: targetColumnId,
              position: clampedPos,
              version: { increment: 1 },
            },
          });

          // Atualiza orderVersion em ambas as colunas
          await tx.column.update({
            where: { id: existing.columnId },
            data: { orderVersion: { increment: 1 } },
          });
          await tx.column.update({
            where: { id: targetColumnId },
            data: { orderVersion: { increment: 1 } },
          });
        }

        // Auditoria transacional (E3.5-c)
        await ActivityService.log(
          {
            workspaceId: existing.workspaceId,
            projectId: existing.projectId,
            taskId: existing.id,
            userId: actor.id,
            userName: (actor as any).name || 'Usuário',
            action: 'moved_task',
            details: {
              sourceColumnId: existing.columnId,
              targetColumnId,
              targetPosition,
            },
          },
          tx
        );

        return tx.task.findUniqueOrThrow({
          where: { id: existing.id },
          include: {
            column: true,
            project: { select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true } },
            labels: { include: { label: true } },
          },
        });
      }
    );

    await ShareService.touchPublicContent(existing.id);

    return toTaskInternalDTO(updated);
  }

  static async archiveTask(id: string, actor: Actor) {
    const existing = await AccessService.getAuthorizedTask(id, actor, 'archive_task');

    await ShareService.revokeSharesForScope({ taskId: existing.id });

    const task = await withTransaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id: existing.id },
        data: {
          isArchived: true,
          archivedAt: new Date(),
          archivedById: actor.id,
          version: { increment: 1 },
        },
        include: {
          column: true,
          project: {
            select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true },
          },
          labels: { include: { label: true } },
        },
      });

      await ActivityService.log(
        {
          workspaceId: existing.workspaceId,
          projectId: existing.projectId,
          taskId: existing.id,
          actor,
          action: 'task.archived',
          details: { title: updated.title, taskNumber: updated.taskNumber },
        },
        tx
      );

      return updated;
    });

    return toTaskInternalDTO(task);
  }

  static async restoreTask(id: string, actor: Actor) {
    const existing = await AccessService.getAuthorizedTask(id, actor, 'restore_task');

    const task = await withTransaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id: existing.id },
        data: {
          isArchived: false,
          archivedAt: null,
          archivedById: null,
          deletedAt: null,
          deletedById: null,
          deletionReason: null,
          version: { increment: 1 },
        },
        include: {
          column: true,
          project: {
            select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true },
          },
          labels: { include: { label: true } },
        },
      });

      await ActivityService.log(
        {
          workspaceId: existing.workspaceId,
          projectId: existing.projectId,
          taskId: existing.id,
          actor,
          action: 'task.restored',
          details: { title: updated.title, taskNumber: updated.taskNumber },
        },
        tx
      );

      return updated;
    });

    return toTaskInternalDTO(task);
  }

  static async deleteTask(id: string, actor: Actor, reason?: string) {
    const existing = await AccessService.getAuthorizedTask(id, actor, 'delete_task');

    await ShareService.revokeSharesForScope({ taskId: existing.id });

    const task = await withTransaction(async (tx) => {
      const deleted = await tx.task.update({
        where: { id: existing.id },
        data: {
          deletedAt: new Date(),
          deletedById: actor.id,
          deletionReason: reason || null,
          version: { increment: 1 },
        },
        include: {
          column: true,
          project: {
            select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true },
          },
          labels: { include: { label: true } },
        },
      });

      await ActivityService.log(
        {
          workspaceId: existing.workspaceId,
          projectId: existing.projectId,
          taskId: existing.id,
          actor,
          action: 'task.deleted',
          details: { deletedTaskId: existing.id, title: deleted.title, taskNumber: deleted.taskNumber, reason },
        },
        tx
      );

      return deleted;
    });

    return toTaskInternalDTO(task);
  }

  static async incrementTaskVersion(taskId: string): Promise<number> {
    try {
      const updated = await prisma.task.update({
        where: { id: taskId },
        data: { version: { increment: 1 } },
        select: { version: true },
      });
      return updated.version;
    } catch {
      return 0;
    }
  }

  // --- Subtasks ---
  static async addSubtask(taskId: string, title: string, actor: Actor) {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'create_subtask');

    const last = await prisma.subtask.findFirst({
      where: { taskId: task.id },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = last ? last.position + 1 : 0;

    const subtask = await prisma.subtask.create({
      data: {
        taskId: task.id,
        title,
        position,
      },
    });

    await TaskService.incrementTaskVersion(task.id);
    await ShareService.touchPublicContent(task.id);

    return subtask;
  }

  static async updateSubtask(id: string, data: { title?: string; completed?: boolean; position?: number }, actor: Actor) {
    const subtask = await prisma.subtask.findUnique({
      where: { id },
      include: { task: { select: { id: true, workspaceId: true } } },
    });
    if (!subtask) throw new NotFoundError('Subtarefa não encontrada.');

    await AccessService.assertCan(actor, 'edit_subtask', { workspaceId: subtask.task.workspaceId });

    const updated = await prisma.subtask.update({
      where: { id },
      data,
    });

    await TaskService.incrementTaskVersion(subtask.task.id);
    await ShareService.touchPublicContent(subtask.task.id);

    return updated;
  }

  static async deleteSubtask(id: string, actor: Actor) {
    const subtask = await prisma.subtask.findUnique({
      where: { id },
      include: { task: { select: { id: true, workspaceId: true } } },
    });
    if (!subtask) throw new NotFoundError('Subtarefa não encontrada.');

    await AccessService.assertCan(actor, 'delete_subtask', { workspaceId: subtask.task.workspaceId });

    const deleted = await prisma.subtask.delete({
      where: { id },
    });

    await TaskService.incrementTaskVersion(subtask.task.id);
    await ShareService.touchPublicContent(subtask.task.id);

    return deleted;
  }

  // --- Relations (E3.4-c / T12) ---
  static async addRelation(taskId: string, relatedTaskId: string, type: RelationType | string, actor: Actor) {
    if (taskId === relatedTaskId) {
      throw new ValidationError('Uma tarefa não pode se relacionar consigo mesma.');
    }

    const task = await AccessService.getAuthorizedTask(taskId, actor, 'create_relation');
    const relatedTask = await AccessService.getAuthorizedTask(relatedTaskId, actor, 'create_relation');

    // I2: Tarefas relacionadas devem pertencer ao mesmo projeto
    if (task.projectId !== relatedTask.projectId) {
      throw new ValidationError('Tarefas relacionadas devem pertencer ao mesmo projeto.');
    }

    // Normalização canônica (3.4-c):
    // BLOCKS: salva no sentido "quem bloqueia -> quem é bloqueado"
    // BLOCKED_BY: inverte a direção para salvar como BLOCKS
    // RELATES_TO: ordena lexicograficamente os IDs para que o par seja único
    let fromId: string;
    let toId: string;
    let normalizedType: RelationType;

    const upperType = String(type).toUpperCase();
    if (upperType === 'BLOCKS') {
      fromId = task.id;
      toId = relatedTask.id;
      normalizedType = RelationType.BLOCKS;
    } else if (upperType === 'BLOCKED_BY') {
      fromId = relatedTask.id;
      toId = task.id;
      normalizedType = RelationType.BLOCKS;
    } else if (upperType === 'RELATES_TO') {
      const [first, second] = task.id < relatedTask.id ? [task.id, relatedTask.id] : [relatedTask.id, task.id];
      fromId = first;
      toId = second;
      normalizedType = RelationType.RELATES_TO;
    } else {
      throw new ValidationError(`Tipo de relação inválido: ${type}`);
    }

    // Executa sob bloqueio pessimista do projeto para serializar mutações e evitar condições de corrida (T12)
    const relation = await withProjectLock(task.projectId, async (tx) => {
      // 1. Verifica duplicata
      const existingRel = await tx.taskRelation.findUnique({
        where: {
          taskId_relatedTaskId_type: {
            taskId: fromId,
            relatedTaskId: toId,
            type: normalizedType,
          },
        },
      });
      if (existingRel) {
        throw new ConflictError('Esta relação já existe entre as tarefas especificadas.');
      }

      // 2. Para BLOCKS: detecção de ciclo no grafo de dependências
      if (normalizedType === RelationType.BLOCKS) {
        const hasCycle = await wouldCreateBlockCycle(task.projectId, fromId, toId, tx);
        if (hasCycle) {
          throw new ValidationError('Não é possível criar esta relação pois causaria uma dependência circular (ciclo).');
        }
      }

      // 3. Criação da relação
      const created = await tx.taskRelation.create({
        data: {
          taskId: fromId,
          relatedTaskId: toId,
          type: normalizedType,
        },
      });

      // 4. Incremento das versões das tarefas envolvidas
      await tx.task.update({
        where: { id: fromId },
        data: { version: { increment: 1 } },
      });
      await tx.task.update({
        where: { id: toId },
        data: { version: { increment: 1 } },
      });

      return created;
    });

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      userId: actor.id,
      userName: (actor as any).name || 'Usuário',
      action: 'created_relation',
      details: {
        type: normalizedType,
        targetTaskId: relatedTask.id,
        targetTaskNumber: relatedTask.taskNumber,
      },
    });

    return relation;
  }

  static async removeRelation(id: string, actor: Actor) {
    const relation = await prisma.taskRelation.findUnique({
      where: { id },
      include: {
        task: { select: { id: true, workspaceId: true, projectId: true } },
        relatedTask: { select: { id: true } },
      },
    });
    if (!relation) throw new NotFoundError('Relação não encontrada.');

    await AccessService.assertCan(actor, 'delete_relation', { workspaceId: relation.task.workspaceId });

    const deleted = await withProjectLock(relation.task.projectId, async (tx) => {
      const del = await tx.taskRelation.delete({
        where: { id },
      });

      await tx.task.update({
        where: { id: relation.taskId },
        data: { version: { increment: 1 } },
      });
      await tx.task.update({
        where: { id: relation.relatedTaskId },
        data: { version: { increment: 1 } },
      });

      return del;
    });

    return deleted;
  }

  // --- Resources ---
  static async addResource(taskId: string, data: { title: string; url: string; type?: string }, actor: Actor) {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'create_resource');

    const resource = await prisma.taskResource.create({
      data: {
        taskId: task.id,
        title: data.title,
        url: data.url,
        type: data.type || 'other',
      },
    });

    await TaskService.incrementTaskVersion(task.id);
    await ShareService.touchPublicContent(task.id);

    return resource;
  }

  static async removeResource(id: string, actor: Actor) {
    const resource = await prisma.taskResource.findUnique({
      where: { id },
      include: { task: { select: { id: true, workspaceId: true } } },
    });
    if (!resource) throw new NotFoundError('Recurso não encontrado.');

    await AccessService.assertCan(actor, 'delete_resource', { workspaceId: resource.task.workspaceId });

    const deleted = await prisma.taskResource.delete({
      where: { id },
    });

    await TaskService.incrementTaskVersion(resource.task.id);
    await ShareService.touchPublicContent(resource.task.id);

    return deleted;
  }

  // --- Time Entries (E3.8-c / T04 / T13) ---
  static async addTimeEntry(
    taskId: string,
    data: { description?: string; durationMinutes: number; date?: string },
    actor: Actor
  ) {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'create_time_entry');

    if (!data.durationMinutes || data.durationMinutes <= 0) {
      throw new ValidationError('A duração em minutos deve ser um número positivo maior que zero.');
    }

    const workDate = data.date ? parseCivilDate(data.date)! : new Date();

    const entry = await prisma.timeEntry.create({
      data: {
        taskId: task.id,
        userId: actor.id,
        userName: (actor as any).name || 'Usuário',
        description: data.description ? data.description.trim() : null,
        durationMinutes: data.durationMinutes,
        date: workDate,
      },
    });

    await TaskService.incrementTaskVersion(task.id);

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      actor,
      action: 'time_entry.created',
      details: {
        timeEntryId: entry.id,
        durationMinutes: entry.durationMinutes,
        date: formatCivilDate(entry.date),
      },
    });

    return entry;
  }

  static async updateTimeEntry(
    id: string,
    data: { description?: string; durationMinutes?: number; date?: string },
    actor: Actor
  ) {
    const entry = await prisma.timeEntry.findUnique({
      where: { id },
      include: { task: { select: { id: true, workspaceId: true, projectId: true } } },
    });
    if (!entry) throw new NotFoundError('Apontamento de tempo não encontrado.');

    // Autoria: MEMBER só pode editar os próprios registros; ADMIN pode editar todos (Seção 3.3)
    await AccessService.assertCan(actor, 'edit_time_entry', {
      workspaceId: entry.task.workspaceId,
      authorId: entry.userId,
    });

    const updateData: any = {};

    if (data.durationMinutes !== undefined) {
      if (data.durationMinutes <= 0) {
        throw new ValidationError('A duração em minutos deve ser positiva.');
      }
      updateData.durationMinutes = data.durationMinutes;
    }

    if (data.description !== undefined) {
      updateData.description = data.description ? data.description.trim() : null;
    }

    if (data.date !== undefined) {
      updateData.date = parseCivilDate(data.date)!;
    }

    const updated = await prisma.timeEntry.update({
      where: { id },
      data: updateData,
    });

    await TaskService.incrementTaskVersion(entry.task.id);

    await ActivityService.log({
      workspaceId: entry.task.workspaceId,
      projectId: entry.task.projectId,
      taskId: entry.task.id,
      actor,
      action: 'time_entry.updated',
      details: {
        timeEntryId: id,
        changes: updateData,
      },
    });

    return updated;
  }

  static async removeTimeEntry(id: string, actor: Actor) {
    const entry = await prisma.timeEntry.findUnique({
      where: { id },
      include: { task: { select: { id: true, workspaceId: true, projectId: true } } },
    });
    if (!entry) throw new NotFoundError('Apontamento de tempo não encontrado.');

    // Autoria: MEMBER só pode excluir os próprios registros; ADMIN pode excluir todos (Seção 3.3)
    await AccessService.assertCan(actor, 'delete_time_entry', {
      workspaceId: entry.task.workspaceId,
      authorId: entry.userId,
    });

    const deleted = await prisma.timeEntry.delete({
      where: { id },
    });

    await TaskService.incrementTaskVersion(entry.task.id);

    await ActivityService.log({
      workspaceId: entry.task.workspaceId,
      projectId: entry.task.projectId,
      taskId: entry.task.id,
      actor,
      action: 'time_entry.deleted',
      details: {
        timeEntryId: id,
        durationMinutes: entry.durationMinutes,
      },
    });

    return deleted;
  }

  static async listTimeEntries(taskId: string, actor: Actor) {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'read_task');

    const entries = await prisma.timeEntry.findMany({
      where: { taskId: task.id },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    const totalMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);
    const totalHours = Number((totalMinutes / 60).toFixed(2));

    return {
      entries,
      totalMinutes,
      totalHours,
    };
  }

  // --- Comments ---
  static async addComment(
    taskId: string,
    content: string,
    actor: Actor,
    mentionUserIds?: string[]
  ) {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'create_comment');

    let validMentionIds: string[] = [];
    if (mentionUserIds && mentionUserIds.length > 0) {
      const activeMembers = await prisma.workspaceMember.findMany({
        where: {
          workspaceId: task.workspaceId,
          userId: { in: mentionUserIds },
          status: 'ACTIVE',
        },
        select: { userId: true },
      });
      const activeSet = new Set(activeMembers.map((m) => m.userId));
      validMentionIds = mentionUserIds.filter((id) => activeSet.has(id));
    }

    const comment = await prisma.comment.create({
      data: {
        taskId: task.id,
        userId: actor.id,
        userName: (actor as any).name || 'Usuário',
        userAvatar: (actor as any).avatarUrl,
        content,
        mentions:
          validMentionIds.length > 0
            ? {
                create: validMentionIds.map((uid) => ({ userId: uid })),
              }
            : undefined,
      },
      include: {
        mentions: true,
      },
    });

    // Notifica os usuários mencionados (exceto o autor)
    for (const uid of validMentionIds) {
      if (uid !== actor.id) {
        await NotificationService.create({
          workspaceId: task.workspaceId,
          userId: uid,
          taskId: task.id,
          actorId: actor.id,
          title: 'Você foi mencionado em um comentário',
          content: `${(actor as any).name || 'Alguém'} mencionou você na tarefa "${task.title}".`,
          type: 'mention',
          dedupKey: `task_mention:${comment.id}:${uid}`,
        });
      }
    }

    // Notifica o responsável da tarefa se não for o autor nem mencionado
    if (
      task.assigneeId &&
      task.assigneeId !== actor.id &&
      !validMentionIds.includes(task.assigneeId)
    ) {
      await NotificationService.create({
        workspaceId: task.workspaceId,
        userId: task.assigneeId,
        taskId: task.id,
        actorId: actor.id,
        title: 'Novo comentário na tarefa',
        content: `${(actor as any).name || 'Alguém'} comentou na tarefa "${task.title}".`,
        type: 'comment',
        dedupKey: `task_comment:${comment.id}:${task.assigneeId}`,
      });
    }

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      actor,
      action: 'comment.created',
      details: { commentId: comment.id, mentionsCount: validMentionIds.length },
    });

    await TaskService.incrementTaskVersion(task.id);

    return comment;
  }

  static async updateComment(
    id: string,
    content: string,
    actor: Actor,
    mentionUserIds?: string[]
  ) {
    const comment = await prisma.comment.findUnique({
      where: { id },
      include: {
        task: {
          select: { id: true, title: true, workspaceId: true, projectId: true },
        },
        mentions: true,
      },
    });

    if (!comment) {
      throw new NotFoundError('Comentário não encontrado.');
    }

    // Autoria: MEMBER só pode editar os próprios comentários; ADMIN pode editar todos (Seção 3.3)
    await AccessService.assertCan(actor, 'edit_comment', {
      workspaceId: comment.task.workspaceId,
      authorId: comment.userId,
    });

    let newlyAddedMentions: string[] = [];

    if (mentionUserIds !== undefined) {
      const activeMembers = await prisma.workspaceMember.findMany({
        where: {
          workspaceId: comment.task.workspaceId,
          userId: { in: mentionUserIds },
          status: 'ACTIVE',
        },
        select: { userId: true },
      });
      const activeSet = new Set(activeMembers.map((m) => m.userId));
      const validMentionIds = mentionUserIds.filter((uid) => activeSet.has(uid));

      const existingSet = new Set(comment.mentions.map((m) => m.userId));
      newlyAddedMentions = validMentionIds.filter((uid) => !existingSet.has(uid));

      // Remove menções desmarcadas
      await prisma.commentMention.deleteMany({
        where: {
          commentId: id,
          userId: { notIn: validMentionIds },
        },
      });

      // Insere novas menções
      if (newlyAddedMentions.length > 0) {
        await prisma.commentMention.createMany({
          data: newlyAddedMentions.map((uid) => ({ commentId: id, userId: uid })),
          skipDuplicates: true,
        });
      }

      // Notifica ESTRITAMENTE as novas menções adicionadas nesta edição (E3.6-c)
      for (const uid of newlyAddedMentions) {
        if (uid !== actor.id) {
          await NotificationService.create({
            workspaceId: comment.task.workspaceId,
            userId: uid,
            taskId: comment.task.id,
            actorId: actor.id,
            title: 'Você foi mencionado em um comentário',
            content: `${(actor as any).name || 'Alguém'} mencionou você na tarefa "${comment.task.title}".`,
            type: 'mention',
            dedupKey: `task_mention:${id}:${uid}`,
          });
        }
      }
    }

    const updated = await prisma.comment.update({
      where: { id },
      data: { content },
      include: { mentions: true },
    });

    await ActivityService.log({
      workspaceId: comment.task.workspaceId,
      projectId: comment.task.projectId,
      taskId: comment.task.id,
      actor,
      action: 'comment.updated',
      details: { commentId: id, newlyAddedMentionsCount: newlyAddedMentions.length },
    });

    await TaskService.incrementTaskVersion(comment.task.id);

    return updated;
  }

  static async deleteComment(id: string, actor: Actor) {
    const comment = await prisma.comment.findUnique({
      where: { id },
      include: { task: { select: { id: true, workspaceId: true } } },
    });
    if (!comment) throw new NotFoundError('Comentário não encontrado.');

    // Autoria: MEMBER só pode excluir os próprios comentários; ADMIN pode excluir todos (Seção 3.3)
    await AccessService.assertCan(actor, 'delete_comment', {
      workspaceId: comment.task.workspaceId,
      authorId: comment.userId,
    });

    const deleted = await prisma.comment.delete({
      where: { id },
    });

    await TaskService.incrementTaskVersion(comment.task.id);

    return deleted;
  }

  static async listComments(
    taskId: string,
    actor: Actor,
    paginationQuery: { cursor?: string; limit?: string | number } = {}
  ) {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'read_task');
    const { cursor, limit } = parsePaginationParams(paginationQuery);

    const comments = await prisma.comment.findMany({
      where: { taskId: task.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      include: {
        mentions: true,
      },
    });

    return buildCursorResponse(comments, limit);
  }

  // ==========================================
  // Integrações CRM / Agente de Atendimento (E4.2-b / Seção 9.3)
  // ==========================================

  /**
   * Vincula explicitamente uma tarefa existente a um contexto do CRM
   */
  static async linkTaskToCrm(
    taskId: string,
    crmContext: {
      crmInstanceId: string;
      crmContactId: string;
      crmConversationId?: string | null;
    },
    actor: Actor
  ) {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'write_task');
    const instanceId = crmContext.crmInstanceId?.trim();
    if (!instanceId) {
      throw new ValidationError('crmInstanceId é obrigatório para vínculo CRM.');
    }
    const contactId = crmContext.crmContactId?.trim();
    if (!contactId) {
      throw new ValidationError('crmContactId é obrigatório para vínculo CRM.');
    }

    const link = await prisma.taskCrmLink.upsert({
      where: {
        taskId: task.id,
      },
      create: {
        taskId: task.id,
        crmInstanceId: instanceId,
        crmContactId: contactId,
        crmConversationId: crmContext.crmConversationId?.trim() || null,
      },
      update: {
        crmInstanceId: instanceId,
        crmContactId: contactId,
        crmConversationId: crmContext.crmConversationId?.trim() || null,
      },
    });

    return link;
  }

  /**
   * Listagem restrita para agentes atendendo clientes externos (E4.2-b, E4.2-c / DP14).
   * Somente retorna tarefas associadas ao contato ou conversa do cliente solicitante.
   * Não expõe dados internos (comentários, horas, membros, outras tarefas).
   */
  static async listTasksForCustomerAgent(input: {
    crmInstanceId: string;
    crmContactId?: string | null;
    crmConversationId?: string | null;
    cursor?: string;
    limit?: number | string;
  }) {
    const { cursor, limit } = parsePaginationParams(input);
    const instanceId = input.crmInstanceId?.trim();
    if (!instanceId) {
      throw new ValidationError('crmInstanceId é obrigatório para consultas do atendimento.');
    }
    const contactId = input.crmContactId?.trim();
    const conversationId = input.crmConversationId?.trim();
    if (!contactId && !conversationId) {
      throw new ValidationError('crmContactId ou crmConversationId é obrigatório.');
    }

    const orConditions: any[] = [];
    if (contactId) orConditions.push({ crmContactId: contactId });
    if (conversationId) orConditions.push({ crmConversationId: conversationId });

    const links = await prisma.taskCrmLink.findMany({
      where: {
        crmInstanceId: instanceId,
        OR: orConditions,
        task: {
          deletedAt: null,
          isArchived: false,
          project: {
            deletedAt: null,
            isArchived: false,
            workspace: {
              deletedAt: null,
              isArchived: false,
            },
          },
        },
      },
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      orderBy: { createdAt: 'desc' },
      include: {
        task: {
          include: {
            project: { select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true } },
            column: { select: { id: true, name: true, color: true, isDoneColumn: true } },
            subtasks: { select: { id: true, completed: true } },
          },
        },
      },
    });

    const tasks = links.map((l) => {
      const t = l.task;
      const completed = t.subtasks.filter((s) => s.completed).length;
      const total = t.subtasks.length;
      const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
      return {
        ...t,
        subtaskProgress: progress,
      };
    });

    return buildCursorResponse(toTaskCustomerAgentListDTO(tasks), limit);
  }

  /**
   * Consulta detalhada de uma tarefa pelo agente de atendimento ao cliente (E4.2-b / E4.2-c).
   * Lança NotFoundError se a tarefa pertencer a outro contato ou instância (sem vazar metadados).
   */
  static async getTaskForCustomerAgent(
    taskId: string,
    input: {
      crmInstanceId: string;
      crmContactId?: string | null;
      crmConversationId?: string | null;
    }
  ) {
    const instanceId = input.crmInstanceId?.trim();
    if (!instanceId) {
      throw new ValidationError('crmInstanceId é obrigatório.');
    }
    const contactId = input.crmContactId?.trim();
    const conversationId = input.crmConversationId?.trim();
    if (!contactId && !conversationId) {
      throw new ValidationError('crmContactId ou crmConversationId é obrigatório.');
    }

    const orConditions: any[] = [];
    if (contactId) orConditions.push({ crmContactId: contactId });
    if (conversationId) orConditions.push({ crmConversationId: conversationId });

    const link = await prisma.taskCrmLink.findFirst({
      where: {
        taskId,
        crmInstanceId: instanceId,
        OR: orConditions,
        task: {
          deletedAt: null,
          isArchived: false,
          project: {
            deletedAt: null,
            isArchived: false,
            workspace: {
              deletedAt: null,
              isArchived: false,
            },
          },
        },
      },
      include: {
        task: {
          include: {
            project: { select: { id: true, name: true, key: true, slug: true, color: true, workspaceId: true } },
            column: { select: { id: true, name: true, color: true, isDoneColumn: true } },
            subtasks: { select: { id: true, completed: true } },
          },
        },
      },
    });

    if (!link || !link.task) {
      throw new NotFoundError('Tarefa não encontrada ou fora do escopo autorizado.');
    }

    const t = link.task;
    const completed = t.subtasks.filter((s) => s.completed).length;
    const total = t.subtasks.length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    return toTaskCustomerAgentDTO({
      ...t,
      subtaskProgress: progress,
    });
  }
}
