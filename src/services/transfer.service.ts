import prisma from '../db/prisma.js';
import { AccessService } from './access.service.js';
import { ActivityService } from './activity.service.js';
import { withTransaction, withProjectLock } from '../db/tx.js';
import { Actor } from '../types/auth.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../errors/app-error.js';
import { toTaskInternalDTO } from '../dto/task-dto.js';

export interface TransferPreviewResult {
  taskId: string;
  sourceProject: {
    id: string;
    name: string;
    key: string;
    displayCode: string;
  };
  targetProject: {
    id: string;
    name: string;
    key: string;
  };
  currentDisplayCode: string;
  projectedTaskNumber: number;
  projectedDisplayCode: string;
  targetColumns: Array<{
    id: string;
    name: string;
    position: number;
  }>;
  incompatibleRelationsCount: number;
  incompatibleRelations: Array<{
    id: string;
    type: string;
    relatedTaskId: string;
    relatedTaskTitle: string;
  }>;
  sharesToRevokeCount: number;
  unmappedCustomFieldsCount: number;
}

export class TransferService {
  /**
   * Gera a prévia de transferência de projeto (E3.6-e / Seção 6.4).
   * Aponta mudança de código, colunas disponíveis, relações incompatíveis,
   * campos personalizados e compartilhamentos que serão revogados.
   */
  static async preview(
    taskId: string,
    targetProjectId: string,
    actor: Actor
  ): Promise<TransferPreviewResult> {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'transfer_task');

    if (task.projectId === targetProjectId) {
      throw new ValidationError('O projeto de destino deve ser diferente do projeto de origem.');
    }

    const targetProject = await prisma.project.findUnique({
      where: { id: targetProjectId },
      include: {
        columns: {
          orderBy: { position: 'asc' },
          select: { id: true, name: true, position: true },
        },
        customFields: true,
      },
    });

    if (!targetProject) {
      throw new NotFoundError('Projeto de destino não encontrado.');
    }

    if (targetProject.workspaceId !== task.workspaceId) {
      throw new ValidationError('A transferência de projeto só é permitida dentro do mesmo workspace.');
    }

    if (targetProject.isArchived || targetProject.deletedAt) {
      throw new ForbiddenError('Não é possível transferir para um projeto arquivado ou excluído.');
    }

    // Valida permissão do ator no projeto de destino
    await AccessService.assertCan(actor, 'transfer_task', {
      workspaceId: targetProject.workspaceId,
      isProjectArchived: targetProject.isArchived,
    });

    const sourceProject = await prisma.project.findUniqueOrThrow({
      where: { id: task.projectId },
      select: { id: true, name: true, key: true },
    });

    const currentDisplayCode = `${sourceProject.key}-${task.taskNumber}`;
    const projectedTaskNumber = targetProject.taskCounter + 1;
    const projectedDisplayCode = `${targetProject.key}-${projectedTaskNumber}`;

    // Relações entre tarefas: só sobrevivem se ambas as tarefas pertencerem ao projeto de destino
    const relations = await prisma.taskRelation.findMany({
      where: {
        OR: [{ taskId: task.id }, { relatedTaskId: task.id }],
      },
      include: {
        task: { select: { id: true, title: true, projectId: true } },
        relatedTask: { select: { id: true, title: true, projectId: true } },
      },
    });

    const incompatibleRelations = relations
      .filter((r) => {
        const otherTask = r.taskId === task.id ? r.relatedTask : r.task;
        return otherTask.projectId !== targetProjectId;
      })
      .map((r) => {
        const otherTask = r.taskId === task.id ? r.relatedTask : r.task;
        return {
          id: r.id,
          type: r.type,
          relatedTaskId: otherTask.id,
          relatedTaskTitle: otherTask.title,
        };
      });

    // Compartilhamentos públicos da tarefa que serão revogados
    const sharesCount = await prisma.taskShare.count({
      where: { taskId: task.id, revokedAt: null },
    });

    // Campos personalizados sem correspondência no projeto de destino
    const taskCustomValues = await prisma.customFieldValue.findMany({
      where: { taskId: task.id },
      include: { field: true },
    });

    const targetFieldNames = new Set(targetProject.customFields.map((f) => f.name.toLowerCase()));
    const unmappedCustomFields = taskCustomValues.filter(
      (v) => !targetFieldNames.has(v.field.name.toLowerCase())
    );

    return {
      taskId: task.id,
      sourceProject: {
        id: sourceProject.id,
        name: sourceProject.name,
        key: sourceProject.key,
        displayCode: currentDisplayCode,
      },
      targetProject: {
        id: targetProject.id,
        name: targetProject.name,
        key: targetProject.key,
      },
      currentDisplayCode,
      projectedTaskNumber,
      projectedDisplayCode,
      targetColumns: targetProject.columns,
      incompatibleRelationsCount: incompatibleRelations.length,
      incompatibleRelations,
      sharesToRevokeCount: sharesCount,
      unmappedCustomFieldsCount: unmappedCustomFields.length,
    };
  }

  /**
   * Executa a transferência de projeto transacionalmente (E3.6-e / Seção 6.4).
   * - Trava projetos em ordem determinística contra deadlocks.
   * - Aloca novo taskNumber no destino pelo taskCounter.
   * - Deleta relações incompatíveis e revoga shares em cascata.
   * - Preserva comentários, menções, subtarefas e apontamentos.
   * - Registra códigos antigo e novo na auditoria Activity definitiva.
   */
  static async execute(params: {
    taskId: string;
    targetProjectId: string;
    targetColumnId: string;
    actor: Actor;
  }) {
    const { taskId, targetProjectId, targetColumnId, actor } = params;

    const task = await AccessService.getAuthorizedTask(taskId, actor, 'transfer_task');

    if (task.projectId === targetProjectId) {
      throw new ValidationError('O projeto de destino deve ser diferente do projeto de origem.');
    }

    const targetProject = await prisma.project.findUnique({
      where: { id: targetProjectId },
      include: {
        columns: true,
        customFields: true,
      },
    });

    if (!targetProject) {
      throw new NotFoundError('Projeto de destino não encontrado.');
    }

    if (targetProject.workspaceId !== task.workspaceId) {
      throw new ValidationError('A transferência de projeto só é permitida dentro do mesmo workspace.');
    }

    if (targetProject.isArchived || targetProject.deletedAt) {
      throw new ForbiddenError('Não é possível transferir para um projeto arquivado ou excluído.');
    }

    const targetColumn = targetProject.columns.find((c) => c.id === targetColumnId);
    if (!targetColumn) {
      throw new ValidationError('A coluna de destino informada não pertence ao projeto de destino.');
    }

    await AccessService.assertCan(actor, 'transfer_task', {
      workspaceId: targetProject.workspaceId,
      isProjectArchived: targetProject.isArchived,
    });

    const sourceProject = await prisma.project.findUniqueOrThrow({
      where: { id: task.projectId },
      select: { id: true, name: true, key: true },
    });

    const oldDisplayCode = `${sourceProject.key}-${task.taskNumber}`;

    const updatedTask = await withTransaction(async (tx) => {
      // Bloqueio determinístico dos dois projetos para evitar deadlocks
      const [firstLock, secondLock] = [task.projectId, targetProjectId].sort();
      if (typeof (tx as any).$executeRawUnsafe === 'function') {
        await tx.$executeRawUnsafe(
          'SELECT 1 FROM "projects" WHERE "id" = $1 FOR UPDATE',
          firstLock
        );
        if (firstLock !== secondLock) {
          await tx.$executeRawUnsafe(
            'SELECT 1 FROM "projects" WHERE "id" = $1 FOR UPDATE',
            secondLock
          );
        }
      }

      // Incrementa taskCounter do projeto de destino
      const destProject = await tx.project.update({
        where: { id: targetProjectId },
        data: { taskCounter: { increment: 1 } },
      });
      const newTaskNumber = destProject.taskCounter;
      const newDisplayCode = `${destProject.key}-${newTaskNumber}`;

      // Revoga compartilhamentos públicos da tarefa (E2.4-b / T14)
      await tx.taskShare.updateMany({
        where: { taskId: task.id, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedByActor: `system:transfer_task:${actor.id}`,
        },
      });

      // Remove relações que cruzariam projetos diferentes
      const relations = await tx.taskRelation.findMany({
        where: {
          OR: [{ taskId: task.id }, { relatedTaskId: task.id }],
        },
        include: {
          task: { select: { id: true, projectId: true } },
          relatedTask: { select: { id: true, projectId: true } },
        },
      });

      const incompatibleIds = relations
        .filter((r) => {
          const other = r.taskId === task.id ? r.relatedTask : r.task;
          return other.projectId !== targetProjectId;
        })
        .map((r) => r.id);

      if (incompatibleIds.length > 0) {
        await tx.taskRelation.deleteMany({
          where: { id: { in: incompatibleIds } },
        });
      }

      // Mapeia ou descarta valores de campos personalizados sem correspondência
      const customValues = await tx.customFieldValue.findMany({
        where: { taskId: task.id },
        include: { field: true },
      });

      const targetFieldMap = new Map<string, string>();
      for (const tf of targetProject.customFields) {
        targetFieldMap.set(tf.name.toLowerCase(), tf.id);
      }

      for (const cv of customValues) {
        const matchingTargetFieldId = targetFieldMap.get(cv.field.name.toLowerCase());
        if (matchingTargetFieldId) {
          await tx.customFieldValue.update({
            where: { id: cv.id },
            data: { fieldId: matchingTargetFieldId },
          });
        } else {
          // Descarte com retenção implícita no histórico de auditoria
          await tx.customFieldValue.delete({
            where: { id: cv.id },
          });
        }
      }

      // Atualiza a tarefa com o novo projeto, coluna e taskNumber
      const updated = await tx.task.update({
        where: { id: task.id },
        data: {
          projectId: targetProjectId,
          columnId: targetColumnId,
          taskNumber: newTaskNumber,
          version: { increment: 1 },
        },
        include: {
          column: true,
          project: {
            select: {
              id: true,
              name: true,
              key: true,
              slug: true,
              color: true,
              workspaceId: true,
            },
          },
          labels: { include: { label: true } },
        },
      });

      // Registra a atividade definitiva com ambos os códigos
      await ActivityService.log(
        {
          workspaceId: task.workspaceId,
          projectId: targetProjectId,
          taskId: task.id,
          actor,
          action: 'task.transferred',
          details: {
            fromProjectId: sourceProject.id,
            fromProjectKey: sourceProject.key,
            fromTaskNumber: task.taskNumber,
            fromDisplayCode: oldDisplayCode,
            toProjectId: targetProject.id,
            toProjectKey: targetProject.key,
            toTaskNumber: newTaskNumber,
            toDisplayCode: newDisplayCode,
            targetColumnId,
          },
        },
        tx
      );

      return updated;
    });

    return toTaskInternalDTO(updatedTask);
  }
}
