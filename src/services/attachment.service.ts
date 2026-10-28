import crypto from 'crypto';
import prisma from '../db/prisma.js';
import { AccessService } from './access.service.js';
import { ActivityService } from './activity.service.js';
import { TaskService } from './task.service.js';
import { getStorageProvider } from '../storage/index.js';
import { validateFileBuffer } from '../utils/file-validator.js';
import { LIMITS } from '../config/limits.js';
import { Actor } from '../types/auth.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../errors/app-error.js';
import { hashToken } from '../share/crypto.js';

export interface AttachmentDTO {
  id: string;
  workspaceId: string;
  taskId: string;
  commentId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  hashSha256: string;
  uploadedById: string;
  isCommentAttachment: boolean;
  createdAt: string;
}

export function toAttachmentDTO(att: any): AttachmentDTO {
  return {
    id: att.id,
    workspaceId: att.workspaceId,
    taskId: att.taskId,
    commentId: att.commentId,
    filename: att.filename,
    mimeType: att.mimeType,
    sizeBytes: att.sizeBytes,
    hashSha256: att.hashSha256,
    uploadedById: att.uploadedById,
    isCommentAttachment: Boolean(att.commentId),
    createdAt: att.createdAt.toISOString(),
  };
}

export class AttachmentService {
  /**
   * Upload de anexo com validação rigorosa de assinatura, limites e cota (E3.7-b).
   */
  static async uploadAttachment(params: {
    taskId: string;
    commentId?: string;
    filename: string;
    buffer: Buffer;
    actor: Actor;
  }): Promise<AttachmentDTO> {
    const { taskId, commentId, filename, buffer, actor } = params;

    const task = await AccessService.getAuthorizedTask(taskId, actor, 'create_resource');

    // Validação de limite por arquivo (20 MiB)
    if (buffer.length > LIMITS.ATTACHMENT_MAX_SIZE_BYTES) {
      throw new ValidationError(
        `Arquivo excede o limite máximo permitido de 20 MiB (${LIMITS.ATTACHMENT_MAX_SIZE_BYTES} bytes).`
      );
    }

    // Validação de cota do workspace (10 GiB)
    const currentUsage = await this.getWorkspaceStorageUsage(task.workspaceId);
    if (currentUsage + buffer.length > LIMITS.ATTACHMENT_MAX_WORKSPACE_BYTES) {
      throw new ValidationError(
        'A cota máxima de armazenamento do workspace foi atingida.'
      );
    }

    // Se vinculado a comentário, valida se o comentário existe e pertence à tarefa
    if (commentId) {
      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        select: { id: true, taskId: true },
      });
      if (!comment || comment.taskId !== task.id) {
        throw new ValidationError('Comentário informado não pertence a esta tarefa.');
      }
    }

    // Validação de bytes e extensão real
    const validated = validateFileBuffer(buffer, filename);

    // Chave de armazenamento opaca (isolamento e prevenção de path traversal)
    const storageKey = `${task.workspaceId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${validated.extension}`;

    // Gravação física
    const storageResult = await getStorageProvider().save(storageKey, buffer);

    // Criação no banco de dados
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: task.workspaceId,
        taskId: task.id,
        commentId: commentId || null,
        storageKey,
        filename: validated.sanitizedFilename,
        mimeType: validated.mimeType,
        sizeBytes: storageResult.sizeBytes,
        hashSha256: storageResult.hashSha256,
        uploadedById: actor.id,
      },
    });

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      actor,
      action: 'attachment.uploaded',
      details: {
        attachmentId: attachment.id,
        filename: attachment.filename,
        sizeBytes: attachment.sizeBytes,
        mimeType: attachment.mimeType,
        isCommentAttachment: Boolean(commentId),
      },
    });

    await TaskService.incrementTaskVersion(task.id);

    return toAttachmentDTO(attachment);
  }

  /**
   * Recupera anexo para download interno por membro autenticado (E3.7-c).
   */
  static async getAttachmentForInternalDownload(
    attachmentId: string,
    actor: Actor
  ) {
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        task: {
          select: { id: true, workspaceId: true, projectId: true },
        },
      },
    });

    if (!attachment) {
      throw new NotFoundError('Anexo não encontrado.');
    }

    // Verifica se o ator tem permissão de leitura na tarefa associada
    await AccessService.getAuthorizedTask(attachment.taskId, actor, 'read_task');

    const fileResult = await getStorageProvider().get(attachment.storageKey);
    if (!fileResult) {
      throw new NotFoundError('Arquivo físico não encontrado no armazenamento.');
    }

    return {
      attachment,
      fileResult,
    };
  }

  /**
   * Recupera anexo para download público via compartilhamento por PIN (E3.7-c / T10).
   * - Share deve ser válido e ativo.
   * - Anexo deve pertencer à tarefa do share.
   * - Anexo NÃO pode ser de comentário (comentários são sempre internos).
   * - Anexo deve estar na seleção explícita de TaskShareAttachment.
   */
  static async getAttachmentForPublicDownload(
    shareToken: string,
    attachmentId: string
  ) {
    const tokenHash = hashToken(shareToken);

    const share = await prisma.taskShare.findUnique({
      where: { tokenHash },
      include: {
        attachments: {
          where: { attachmentId },
        },
      },
    });

    if (!share) {
      throw new NotFoundError('Compartilhamento não encontrado.', 'SHARE_NOT_FOUND');
    }

    if (share.revokedAt) {
      throw new NotFoundError('Compartilhamento foi revogado.', 'SHARE_REVOKED');
    }

    if (new Date() > share.expiresAt) {
      throw new NotFoundError('Compartilhamento expirou.', 'SHARE_EXPIRED');
    }

    if (!share.showAttachments) {
      throw new ForbiddenError('A visualização de anexos está desabilitada neste compartilhamento.');
    }

    // Verifica seleção explícita
    if (share.attachments.length === 0) {
      throw new NotFoundError('Anexo não selecionado para compartilhamento público.');
    }

    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment || attachment.taskId !== share.taskId) {
      throw new NotFoundError('Anexo não pertence à tarefa compartilhada.');
    }

    // Invariante de Segurança: anexos de comentários NUNCA são públicos
    if (attachment.commentId) {
      throw new ForbiddenError('Anexos de comentários são estritamente internos e confidenciais.');
    }

    const fileResult = await getStorageProvider().get(attachment.storageKey);
    if (!fileResult) {
      throw new NotFoundError('Arquivo físico não encontrado no armazenamento.');
    }

    return {
      attachment,
      fileResult,
    };
  }

  /**
   * Remove anexo com auditoria e exclusão física (E3.7-c).
   * Apenas o autor do anexo ou ADMIN pode remover.
   */
  static async deleteAttachment(attachmentId: string, actor: Actor) {
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        task: {
          select: { id: true, workspaceId: true, projectId: true },
        },
      },
    });

    if (!attachment) {
      throw new NotFoundError('Anexo não encontrado.');
    }

    // Autorização por autoria ou ADMIN
    await AccessService.assertCan(actor, 'delete_resource', {
      workspaceId: attachment.workspaceId,
      authorId: attachment.uploadedById,
    });

    await prisma.attachment.delete({
      where: { id: attachmentId },
    });

    // Remove arquivo físico
    await getStorageProvider().delete(attachment.storageKey);

    await ActivityService.log({
      workspaceId: attachment.workspaceId,
      projectId: attachment.task.projectId,
      taskId: attachment.taskId,
      actor,
      action: 'attachment.deleted',
      details: {
        attachmentId,
        filename: attachment.filename,
      },
    });

    await TaskService.incrementTaskVersion(attachment.taskId);

    return { success: true };
  }

  /**
   * Lista anexos de uma tarefa para membros autenticados.
   */
  static async listTaskAttachments(
    taskId: string,
    actor: Actor
  ): Promise<AttachmentDTO[]> {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'read_task');

    const attachments = await prisma.attachment.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'desc' },
    });

    return attachments.map(toAttachmentDTO);
  }

  /**
   * Calcula o espaço em bytes ocupado por anexos em um workspace.
   */
  static async getWorkspaceStorageUsage(workspaceId: string): Promise<number> {
    const sum = await prisma.attachment.aggregate({
      where: { workspaceId },
      _sum: { sizeBytes: true },
    });

    return sum._sum.sizeBytes || 0;
  }
}
