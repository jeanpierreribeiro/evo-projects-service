import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { parsePaginationParams, buildCursorResponse } from '../utils/pagination.js';
import { Actor } from '../types/auth.js';

export interface AuditActor {
  id: string;
  name?: string;
  userName?: string;
  type?: string;
  initiatedByUserId?: string | null;
  requestId?: string | null;
}

export function sanitizeAuditDetails(details: any): any {
  if (!details || typeof details !== 'object') return details;
  if (Array.isArray(details)) {
    return details.map(sanitizeAuditDetails);
  }
  const sensitivePatterns = /pin|token|password|cookie|secret|authorization|bearer/i;
  const sanitized: Record<string, any> = {};
  for (const [key, val] of Object.entries(details)) {
    if (sensitivePatterns.test(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (val && typeof val === 'object') {
      sanitized[key] = sanitizeAuditDetails(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

export class ActivityService {
  /**
   * Registra uma atividade de auditoria definitiva (E3.5-c / E3.6-a / T11).
   * Desacoplada historicamente de cascade deletion (onDelete: SetNull).
   * Participa da mesma transação quando `tx` for fornecido.
   * Falhas de auditoria NÃO são engolidas: revertem a alteração correspondente.
   * Sanitiza detalhes para nunca registrar segredos, tokens ou PINs.
   */
  static async log(
    data: {
      workspaceId?: string | null;
      projectId?: string | null;
      taskId?: string | null;
      actor?: Actor | AuditActor;
      userId?: string;
      userName?: string;
      action: string;
      details?: any;
    },
    tx?: Prisma.TransactionClient
  ) {
    const client = tx ?? prisma;

    const actor = data.actor;
    const actorId = actor?.id || data.userId || 'system';
    const actorType =
      actor?.type === 'service'
        ? 'SERVICE'
        : actor?.type === 'shareSession'
        ? 'SHARE_SESSION'
        : 'USER';
    const userName =
      (actor && ('name' in actor ? (actor as any).name : (actor as any).userName)) ||
      data.userName ||
      'Sistema';
    const initiatedByUserId = (actor as any)?.initiatedByUserId || null;
    const requestId = (actor as any)?.requestId || null;

    const sanitized = sanitizeAuditDetails(data.details);

    return client.activity.create({
      data: {
        workspaceId: data.workspaceId ?? undefined,
        projectId: data.projectId ?? undefined,
        taskId: data.taskId ?? undefined,
        actorType,
        actorId,
        userId: actorType === 'USER' ? actorId : (data.userId ?? null),
        userName,
        initiatedByUserId,
        requestId,
        action: data.action,
        details: sanitized,
      },
    });
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

  static async listPaginatedByWorkspace(
    workspaceId: string,
    paginationQuery: { cursor?: string; limit?: string | number } = {}
  ) {
    const { cursor, limit } = parsePaginationParams(paginationQuery);

    const activities = await prisma.activity.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      include: {
        task: {
          select: { id: true, title: true, taskNumber: true },
        },
        project: {
          select: { id: true, name: true, color: true },
        },
      },
    });

    return buildCursorResponse(activities, limit);
  }
}
