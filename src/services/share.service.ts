import prisma from '../db/prisma.js';
import { config } from '../config/env.js';
import { Actor } from '../types/auth.js';
import { AccessService } from './access.service.js';
import {
  generateShareToken,
  hashToken,
  generateSharePin,
  hashPin,
  generateSessionToken,
  hashSessionToken,
  verifyPin,
} from '../share/crypto.js';
import { buildPublicCard } from '../share/public-card.js';
import { ShareIssuedDTO, ShareManagementDTO, TaskPublicDTO } from '../dto/task-dto.js';
import { parsePaginationParams, buildCursorResponse, PaginationResult } from '../utils/pagination.js';
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
} from '../errors/app-error.js';

export interface CreateShareInput {
  expiresInDays?: number;
  showDescription?: boolean;
  showSubtasks?: boolean;
  showResources?: boolean;
  showAttachments?: boolean;
  showCustomFields?: boolean;
  selectedResourceIds?: string[];
  selectedAttachmentIds?: string[];
  selectedCustomFieldIds?: string[];
}

export interface PatchShareInput {
  expiresInDays?: number;
  showDescription?: boolean;
  showSubtasks?: boolean;
  showResources?: boolean;
  showAttachments?: boolean;
  showCustomFields?: boolean;
  selectedResourceIds?: string[];
  selectedAttachmentIds?: string[];
  selectedCustomFieldIds?: string[];
  expectedVersion?: number;
}

export class ShareService {
  /**
   * Valida autorização do ator para gerenciar compartilhamento na tarefa.
   */
  private static async getAuthorizedTaskForShare(actor: Actor, taskId: string) {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'read_task');
    const workspace = await AccessService.getAuthorizedWorkspace(task.workspaceId, actor);

    // Se for ator de serviço, exige permissão explícita canShare no grant
    if (actor.type === 'service') {
      const grant = await prisma.integrationGrant.findFirst({
        where: {
          principalId: actor.id,
          workspaceId: task.workspaceId,
          canShare: true,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });

      if (!grant) {
        throw new ForbiddenError(
          'A credencial de serviço não possui grant com permissão canShare neste workspace.',
          'SERVICE_GRANT_MISSING_CAN_SHARE'
        );
      }
    }

    return { task, workspace };
  }

  /**
   * Gera uma prévia do conteúdo público sem persistir nada no banco.
   */
  static async previewShare(
    actor: Actor,
    taskId: string,
    options: CreateShareInput
  ): Promise<TaskPublicDTO> {
    const { task } = await this.getAuthorizedTaskForShare(actor, taskId);

    const fullTask = await prisma.task.findUnique({
      where: { id: task.id },
      include: {
        column: true,
        subtasks: { orderBy: { position: 'asc' } },
        resources: true,
        attachments: true,
        fieldValues: { include: { field: true } },
      },
    });

    if (!fullTask) {
      throw new NotFoundError('Tarefa não encontrada.');
    }

    return buildPublicCard(fullTask, {
      showDescription: options.showDescription ?? true,
      showSubtasks: options.showSubtasks ?? true,
      showResources: options.showResources ?? true,
      showAttachments: options.showAttachments ?? true,
      showCustomFields: options.showCustomFields ?? true,
      selectedResourceIds: options.selectedResourceIds ?? [],
      selectedAttachmentIds: options.selectedAttachmentIds ?? [],
      selectedCustomFieldIds: options.selectedCustomFieldIds ?? [],
      publicContentUpdatedAt: fullTask.updatedAt,
    });
  }

  /**
   * Cria um novo link de compartilhamento seguro com PIN (E2.2-a).
   * Retorna o token, o link completo e o PIN UMA ÚNICA VEZ.
   */
  static async createShare(
    actor: Actor,
    taskId: string,
    input: CreateShareInput
  ): Promise<ShareIssuedDTO> {
    const { task, workspace } = await this.getAuthorizedTaskForShare(actor, taskId);

    if (task.isArchived) {
      throw new ValidationError('Não é possível compartilhar tarefas arquivadas.');
    }

    // Validação de prazo de expiração (E2.1-c)
    const days = input.expiresInDays ?? config.shareDefaultExpirationDays;
    if (days < 1 || days > config.shareMaxExpirationDays) {
      throw new ValidationError(
        `O prazo de expiração deve ser entre 1 e ${config.shareMaxExpirationDays} dias.`
      );
    }

    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    // Validação de recursos pertencentes à tarefa (Invariante E2.1-b)
    const selectedResourceIds = input.selectedResourceIds || [];
    if (selectedResourceIds.length > 0) {
      const validResources = await prisma.taskResource.findMany({
        where: {
          id: { in: selectedResourceIds },
          taskId: task.id,
        },
        select: { id: true },
      });

      if (validResources.length !== selectedResourceIds.length) {
        throw new ValidationError(
          'Um ou mais recursos selecionados não pertencem a esta tarefa.',
          'INVALID_RESOURCE_SELECTION'
        );
      }
    }

    // Validação de anexos pertencentes à tarefa (Invariante E3.7-a)
    // Anexos de comentários são estritamente internos e não podem ser selecionados
    const selectedAttachmentIds = input.selectedAttachmentIds || [];
    if (selectedAttachmentIds.length > 0) {
      const validAttachments = await prisma.attachment.findMany({
        where: {
          id: { in: selectedAttachmentIds },
          taskId: task.id,
          commentId: null,
        },
        select: { id: true },
      });

      if (validAttachments.length !== selectedAttachmentIds.length) {
        throw new ValidationError(
          'Um ou mais anexos selecionados não pertencem a esta tarefa ou são anexos internos de comentários.',
          'INVALID_ATTACHMENT_SELECTION'
        );
      }
    }

    // Validação de campos personalizados pertencentes ao projeto e elegíveis (Invariante E3.8-a)
    const selectedCustomFieldIds = input.selectedCustomFieldIds || [];
    if (selectedCustomFieldIds.length > 0) {
      const validFields = await prisma.customField.findMany({
        where: {
          id: { in: selectedCustomFieldIds },
          projectId: task.projectId,
          isPublicEligible: true,
        },
        select: { id: true },
      });

      if (validFields.length !== selectedCustomFieldIds.length) {
        throw new ValidationError(
          'Um ou mais campos personalizados selecionados não pertencem a este projeto ou não são elegíveis para clientes.',
          'INVALID_CUSTOM_FIELD_SELECTION'
        );
      }
    }

    // Geração segura de credenciais
    const rawToken = generateShareToken();
    const tokenHash = hashToken(rawToken);
    const rawPin = generateSharePin();
    const pinHash = await hashPin(rawPin);

    // Persistência atômica no banco + Activity
    const actorName = (actor as any).name || (actor.type === 'service' ? 'Integração' : 'Operador');
    const share = await prisma.$transaction(async (tx: any) => {
      const created = await tx.taskShare.create({
        data: {
          workspaceId: workspace.id,
          taskId: task.id,
          tokenHash,
          pinHash,
          createdByActorType: actor.type.toUpperCase(),
          createdById: actor.id,
          expiresAt,
          version: 1,
          showDescription: input.showDescription ?? true,
          showSubtasks: input.showSubtasks ?? true,
          showResources: input.showResources ?? true,
          showAttachments: input.showAttachments ?? true,
          showCustomFields: input.showCustomFields ?? true,
          publicContentUpdatedAt: new Date(),
          resources: {
            create: selectedResourceIds.map((resourceId) => ({
              resourceId,
            })),
          },
          attachments: {
            create: selectedAttachmentIds.map((attachmentId) => ({
              attachmentId,
            })),
          },
          customFields: {
            create: selectedCustomFieldIds.map((customFieldId) => ({
              customFieldId,
            })),
          },
        },
      });

      // Registro de atividade SEM segredos, tokens ou links
      await tx.activity.create({
        data: {
          workspaceId: workspace.id,
          projectId: task.projectId,
          taskId: task.id,
          userId: actor.id,
          userName: actorName,
          action: 'share_created',
          details: {
            shareId: created.id,
            expiresInDays: days,
            showDescription: created.showDescription,
            showSubtasks: created.showSubtasks,
            showResources: created.showResources,
            resourceCount: selectedResourceIds.length,
          },
        },
      });

      return created;
    });

    const publicUrl = `${config.publicBaseUrl}/p/task/${rawToken}`;

    return {
      shareId: share.id,
      url: publicUrl,
      pin: rawPin,
      expiresAt: share.expiresAt.toISOString(),
    };
  }

  /**
   * Lista compartilhamentos da tarefa sanitizados com paginação por cursor (E2.2-d / E3.1-c).
   * MEMBER vê apenas os que criou; ADMIN vê todos.
   */
  static async listTaskShares(
    actor: Actor,
    taskId: string,
    paginationQuery: { cursor?: string; limit?: string | number } = {}
  ): Promise<PaginationResult<ShareManagementDTO>> {
    const { task } = await this.getAuthorizedTaskForShare(actor, taskId);

    const whereClause: any = {
      taskId: task.id,
    };

    // Se for usuário com papel MEMBER, limita aos que ele próprio criou
    if (actor.type === 'user' && actor.role === 'MEMBER') {
      whereClause.createdById = actor.id;
    }

    const { cursor, limit } = parsePaginationParams(paginationQuery);

    const shares = await prisma.taskShare.findMany({
      where: whereClause,
      include: {
        resources: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
    });

    const mapped = shares.map((s: any) => ({
      id: s.id,
      taskId: s.taskId,
      expiresAt: s.expiresAt.toISOString(),
      revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
      createdBy: {
        type: s.createdByActorType,
        id: s.createdById,
      },
      sections: {
        showStatus: true,
        showPriority: true,
        showDates: true,
        showChecklist: s.showSubtasks,
      },
    }));

    return buildCursorResponse(mapped, limit);
  }

  /**
   * Atualiza seções e expiração do compartilhamento com controle de versão otimista (E2.2-d).
   */
  static async patchShare(
    actor: Actor,
    shareId: string,
    input: PatchShareInput
  ): Promise<ShareManagementDTO> {
    const share = await prisma.taskShare.findUnique({
      where: { id: shareId },
      include: { task: true },
    });

    if (!share) {
      throw new NotFoundError('Compartilhamento não encontrado.');
    }

    const { task } = await this.getAuthorizedTaskForShare(actor, share.taskId);

    // Verificação de permissão: ADMIN ou criador original
    if (actor.type === 'user' && actor.role === 'MEMBER' && share.createdById !== actor.id) {
      throw new ForbiddenError('Apenas administradores ou o criador podem alterar este link.');
    }

    // Controle de versão otimista
    if (input.expectedVersion !== undefined && share.version !== input.expectedVersion) {
      throw new ConflictError(
        'O compartilhamento foi modificado concorrentemente por outro operador.',
        'VERSION_CONFLICT'
      );
    }

    let newExpiresAt = share.expiresAt;
    if (input.expiresInDays !== undefined) {
      if (input.expiresInDays < 1 || input.expiresInDays > config.shareMaxExpirationDays) {
        throw new ValidationError(
          `O prazo de expiração deve ser entre 1 e ${config.shareMaxExpirationDays} dias.`
        );
      }
      newExpiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
    }

    // Atualização dos recursos selecionados
    const selectedResourceIds = input.selectedResourceIds;
    if (selectedResourceIds) {
      const validResources = await prisma.taskResource.findMany({
        where: {
          id: { in: selectedResourceIds },
          taskId: task.id,
        },
        select: { id: true },
      });

      if (validResources.length !== selectedResourceIds.length) {
        throw new ValidationError(
          'Um ou mais recursos selecionados não pertencem a esta tarefa.',
          'INVALID_RESOURCE_SELECTION'
        );
      }
    }

    // Atualização dos anexos selecionados (E3.7-c)
    const selectedAttachmentIds = input.selectedAttachmentIds;
    if (selectedAttachmentIds) {
      const validAttachments = await prisma.attachment.findMany({
        where: {
          id: { in: selectedAttachmentIds },
          taskId: task.id,
          commentId: null,
        },
        select: { id: true },
      });

      if (validAttachments.length !== selectedAttachmentIds.length) {
        throw new ValidationError(
          'Um ou mais anexos selecionados não pertencem a esta tarefa ou são anexos internos de comentários.',
          'INVALID_ATTACHMENT_SELECTION'
        );
      }
    }

    // Atualização dos campos personalizados selecionados (E3.8-a)
    const selectedCustomFieldIds = input.selectedCustomFieldIds;
    if (selectedCustomFieldIds) {
      const validFields = await prisma.customField.findMany({
        where: {
          id: { in: selectedCustomFieldIds },
          projectId: task.projectId,
          isPublicEligible: true,
        },
        select: { id: true },
      });

      if (validFields.length !== selectedCustomFieldIds.length) {
        throw new ValidationError(
          'Um ou mais campos personalizados selecionados não pertencem a este projeto ou não são elegíveis para clientes.',
          'INVALID_CUSTOM_FIELD_SELECTION'
        );
      }
    }

    const updated = await prisma.$transaction(async (tx: any) => {
      if (selectedResourceIds !== undefined) {
        await tx.taskShareResource.deleteMany({ where: { shareId: share.id } });
        if (selectedResourceIds.length > 0) {
          await tx.taskShareResource.createMany({
            data: selectedResourceIds.map((resourceId) => ({
              shareId: share.id,
              resourceId,
            })),
          });
        }
      }

      if (selectedAttachmentIds !== undefined) {
        await tx.taskShareAttachment.deleteMany({ where: { shareId: share.id } });
        if (selectedAttachmentIds.length > 0) {
          await tx.taskShareAttachment.createMany({
            data: selectedAttachmentIds.map((attachmentId) => ({
              shareId: share.id,
              attachmentId,
            })),
          });
        }
      }

      if (selectedCustomFieldIds !== undefined) {
        await tx.taskShareCustomField.deleteMany({ where: { shareId: share.id } });
        if (selectedCustomFieldIds.length > 0) {
          await tx.taskShareCustomField.createMany({
            data: selectedCustomFieldIds.map((customFieldId) => ({
              shareId: share.id,
              customFieldId,
            })),
          });
        }
      }

      return tx.taskShare.update({
        where: { id: share.id },
        data: {
          expiresAt: newExpiresAt,
          showDescription: input.showDescription ?? share.showDescription,
          showSubtasks: input.showSubtasks ?? share.showSubtasks,
          showResources: input.showResources ?? share.showResources,
          showAttachments: input.showAttachments ?? share.showAttachments,
          showCustomFields: input.showCustomFields ?? share.showCustomFields,
          version: { increment: 1 },
          publicContentUpdatedAt: new Date(),
        },
      });
    });

    return {
      id: updated.id,
      taskId: updated.taskId,
      expiresAt: updated.expiresAt.toISOString(),
      revokedAt: updated.revokedAt ? updated.revokedAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
      createdBy: {
        type: updated.createdByActorType,
        id: updated.createdById,
      },
      sections: {
        showStatus: true,
        showPriority: true,
        showDates: true,
        showChecklist: updated.showSubtasks,
      },
    };
  }

  /**
   * Revoga um compartilhamento ativamente (E2.2-d). Idempotente.
   */
  static async revokeShare(actor: Actor, shareId: string): Promise<{ success: boolean; revokedAt: string }> {
    const share = await prisma.taskShare.findUnique({
      where: { id: shareId },
    });

    if (!share) {
      throw new NotFoundError('Compartilhamento não encontrado.');
    }

    await this.getAuthorizedTaskForShare(actor, share.taskId);

    if (actor.type === 'user' && actor.role === 'MEMBER' && share.createdById !== actor.id) {
      throw new ForbiddenError('Apenas administradores ou o criador podem revogar este link.');
    }

    if (share.revokedAt) {
      return { success: true, revokedAt: share.revokedAt.toISOString() };
    }

    const now = new Date();
    const actorName = (actor as any).name || (actor.type === 'service' ? 'Integração' : 'Operador');

    await prisma.$transaction(async (tx: any) => {
      // 1. Marca o share como revogado
      await tx.taskShare.update({
        where: { id: share.id },
        data: {
          revokedAt: now,
          revokedByActor: actor.id,
        },
      });

      // 2. Revoga imediatamente todas as sessões ativas deste share
      await tx.taskShareSession.updateMany({
        where: {
          shareId: share.id,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      });

      // 3. Registra atividade
      await tx.activity.create({
        data: {
          workspaceId: share.workspaceId,
          taskId: share.taskId,
          userId: actor.id,
          userName: actorName,
          action: 'share_revoked',
          details: { shareId: share.id },
        },
      });
    });

    return { success: true, revokedAt: now.toISOString() };
  }

  /**
   * Reemite um compartilhamento (revoga o anterior e cria novos segredos atomicamente).
   */
  static async reissueShare(actor: Actor, shareId: string): Promise<ShareIssuedDTO> {
    const existing = await prisma.taskShare.findUnique({
      where: { id: shareId },
      include: { resources: true, attachments: true, customFields: true },
    });

    if (!existing) {
      throw new NotFoundError('Compartilhamento não encontrado.');
    }

    const { task, workspace } = await this.getAuthorizedTaskForShare(actor, existing.taskId);

    if (actor.type === 'user' && actor.role === 'MEMBER' && existing.createdById !== actor.id) {
      throw new ForbiddenError('Apenas administradores ou o criador podem reemitir este link.');
    }

    const now = new Date();
    const rawToken = generateShareToken();
    const tokenHash = hashToken(rawToken);
    const rawPin = generateSharePin();
    const pinHash = await hashPin(rawPin);

    // Mantém o mesmo período de validade remanescente ou padrão
    const remainingMs = Math.max(
      existing.expiresAt.getTime() - now.getTime(),
      config.shareDefaultExpirationDays * 24 * 60 * 60 * 1000
    );
    const expiresAt = new Date(now.getTime() + remainingMs);

    const actorName = (actor as any).name || (actor.type === 'service' ? 'Integração' : 'Operador');
    const newShare = await prisma.$transaction(async (tx: any) => {
      // 1. Revoga o anterior
      await tx.taskShare.update({
        where: { id: existing.id },
        data: {
          revokedAt: now,
          revokedByActor: actor.id,
        },
      });

      await tx.taskShareSession.updateMany({
        where: { shareId: existing.id, revokedAt: null },
        data: { revokedAt: now },
      });

      // 2. Cria o novo
      const created = await tx.taskShare.create({
        data: {
          workspaceId: workspace.id,
          taskId: task.id,
          tokenHash,
          pinHash,
          createdByActorType: actor.type.toUpperCase(),
          createdById: actor.id,
          expiresAt,
          version: 1,
          showDescription: existing.showDescription,
          showSubtasks: existing.showSubtasks,
          showResources: existing.showResources,
          showAttachments: existing.showAttachments,
          showCustomFields: existing.showCustomFields,
          publicContentUpdatedAt: now,
          resources: {
            create: existing.resources.map((r: any) => ({
              resourceId: r.resourceId,
            })),
          },
          attachments: {
            create: existing.attachments.map((a: any) => ({
              attachmentId: a.attachmentId,
            })),
          },
          customFields: {
            create: existing.customFields.map((c: any) => ({
              customFieldId: c.customFieldId,
            })),
          },
        },
      });

      await tx.activity.create({
        data: {
          workspaceId: workspace.id,
          taskId: task.id,
          userId: actor.id,
          userName: actorName,
          action: 'share_reissued',
          details: {
            oldShareId: existing.id,
            newShareId: created.id,
          },
        },
      });

      return created;
    });

    const publicUrl = `${config.publicBaseUrl}/p/task/${rawToken}`;

    return {
      shareId: newShare.id,
      url: publicUrl,
      pin: rawPin,
      expiresAt: newShare.expiresAt.toISOString(),
    };
  }

  /**
   * Atualiza a data de modificação pública dos links ativos da tarefa (E2.2-e).
   */
  static async touchPublicContent(taskId: string): Promise<void> {
    const now = new Date();
    await prisma.taskShare.updateMany({
      where: {
        taskId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        publicContentUpdatedAt: now,
      },
    }).catch(() => {});
  }

  /**
   * Valida a elegibilidade do criador ao acessar o link público (E2.4-a).
   * Se o criador foi desativado, removido do workspace ou perdeu permissões, lança 404 SHARE_UNAVAILABLE.
   */
  static async assertEligible(share: any): Promise<void> {
    const now = new Date();

    // 1. Verifica se a tarefa e o workspace estão ativos
    const task = await prisma.task.findUnique({
      where: { id: share.taskId },
      include: { workspace: true, project: true },
    });

    if (!task || task.isArchived) {
      throw new NotFoundError('Compartilhamento indisponível.', 'SHARE_UNAVAILABLE');
    }

    // 2. Se criado por usuário humano
    if (share.createdByActorType === 'USER') {
      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: share.workspaceId,
            userId: share.createdById,
          },
        },
      });

      if (!membership || membership.status !== 'ACTIVE' || membership.role === 'VIEWER') {
        throw new NotFoundError('Compartilhamento indisponível.', 'SHARE_UNAVAILABLE');
      }

      // Valida projeção no Auth
      const projection = await prisma.userProjection.findUnique({
        where: { id: share.createdById },
      });

      if (projection && !projection.isActive) {
        throw new NotFoundError('Compartilhamento indisponível.', 'SHARE_UNAVAILABLE');
      }
    } else if (share.createdByActorType === 'SERVICE') {
      // 3. Se criado por serviço
      const grant = await prisma.integrationGrant.findFirst({
        where: {
          principalId: share.createdById,
          workspaceId: share.workspaceId,
          canShare: true,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      });

      if (!grant) {
        throw new NotFoundError('Compartilhamento indisponível.', 'SHARE_UNAVAILABLE');
      }
    }
  }

  /**
   * Revoga compartilhamentos em cascata quando escopos são alterados (E2.4-b).
   */
  static async revokeSharesForScope(scope: {
    workspaceId?: string;
    projectId?: string;
    taskId?: string;
    userId?: string;
    memberId?: string;
    principalId?: string;
  }): Promise<number> {
    const now = new Date();
    const where: any = {
      revokedAt: null,
    };

    if (scope.taskId) {
      where.taskId = scope.taskId;
    } else if (scope.projectId) {
      where.task = { projectId: scope.projectId };
    } else if (scope.workspaceId) {
      where.workspaceId = scope.workspaceId;
    }

    if (scope.userId) {
      where.createdById = scope.userId;
    }

    if (scope.principalId) {
      where.createdById = scope.principalId;
      where.createdByActorType = 'SERVICE';
    }

    const sharesToRevoke = await prisma.taskShare.findMany({
      where,
      select: { id: true },
    });

    if (sharesToRevoke.length === 0) return 0;

    const shareIds = sharesToRevoke.map((s: any) => s.id);

    await prisma.$transaction([
      prisma.taskShare.updateMany({
        where: { id: { in: shareIds } },
        data: {
          revokedAt: now,
          revokedByActor: 'system:cascade_revocation',
        },
      }),
      prisma.taskShareSession.updateMany({
        where: { shareId: { in: shareIds }, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    return shareIds.length;
  }
}
