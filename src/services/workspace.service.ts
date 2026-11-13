import prisma from '../db/prisma.js';
import { WorkspaceRole } from '@prisma/client';
import { ActivityService } from './activity.service.js';
import { AccessService } from './access.service.js';
import { ShareService } from './share.service.js';
import { Actor } from '../types/auth.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors/app-error.js';
import { parsePaginationParams, buildCursorResponse } from '../utils/pagination.js';
import { isValidIanaTimezone } from '../utils/dates.js';
import { withWorkspaceLock } from '../db/tx.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
}

export class WorkspaceService {
  /**
   * Lista apenas os workspaces dos quais o usuário é membro ativo (S6 / Leitura pura).
   * Sem auto-bootstrap de workspaces em leituras.
   */
  static async listUserWorkspaces(actor: Actor) {
    if (actor.type !== 'user') return [];

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: actor.id },
      include: {
        workspace: {
          include: {
            _count: {
              select: {
                projects: true,
                members: true,
                tasks: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) {
      try {
        const defaultWs = await this.createWorkspace(
          { name: 'Principal', description: 'Workspace principal' },
          actor
        );
        const wsWithCount = await prisma.workspace.findUnique({
          where: { id: defaultWs.id },
          include: {
            _count: {
              select: {
                projects: true,
                members: true,
                tasks: true,
              },
            },
          },
        });
        return wsWithCount ? [wsWithCount] : [defaultWs];
      } catch (err) {
        console.error('Falha ao auto-criar workspace padrão:', err);
        return [];
      }
    }

    return memberships.map((m) => m.workspace);
  }

  /**
   * Criação explícita de workspace. Criador vira ADMIN na mesma transação.
   */
  static async createWorkspace(
    data: { name: string; description?: string; color?: string; avatarUrl?: string; timezone?: string },
    actor: Actor
  ) {
    if (actor.type !== 'user') {
      throw new ForbiddenError('Apenas usuários podem criar workspaces.');
    }

    const timezone = data.timezone ? data.timezone.trim() : 'America/Sao_Paulo';
    if (!isValidIanaTimezone(timezone)) {
      throw new ValidationError(`Identificador de fuso horário IANA inválido: "${data.timezone}". Exemplo: "America/Sao_Paulo".`);
    }

    let slug = slugify(data.name);
    let count = 1;
    while (await prisma.workspace.findUnique({ where: { slug } })) {
      slug = `${slugify(data.name)}-${count++}`;
    }

    const workspace = await prisma.workspace.create({
      data: {
        name: data.name,
        slug,
        description: data.description,
        color: data.color || '#3b82f6',
        avatarUrl: data.avatarUrl,
        timezone,
        members: {
          create: {
            userId: actor.id,
            email: actor.email,
            name: actor.name,
            role: WorkspaceRole.ADMIN,
          },
        },
      },
    });

    await ActivityService.log({
      workspaceId: workspace.id,
      userId: actor.id,
      userName: actor.name,
      action: 'created_workspace',
      details: { workspaceName: workspace.name },
    });

    return workspace;
  }

  static async getWorkspace(idOrSlug: string, actor: Actor) {
    const workspace = await prisma.workspace.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      include: {
        members: true,
        _count: {
          select: { projects: true, tasks: true, members: true },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace não encontrado.');
    }

    await AccessService.assertCan(actor, 'read_workspace', { workspaceId: workspace.id });
    return workspace;
  }

  static async updateWorkspace(
    id: string,
    data: { name?: string; description?: string; color?: string; avatarUrl?: string; timezone?: string },
    actor: Actor
  ) {
    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundError('Workspace não encontrado.');

    await AccessService.assertCan(actor, 'manage_workspace', { workspaceId: workspace.id });

    if (data.timezone !== undefined) {
      if (!isValidIanaTimezone(data.timezone)) {
        throw new ValidationError(`Identificador de fuso horário IANA inválido: "${data.timezone}". Exemplo: "America/Sao_Paulo".`);
      }
    }

    const updated = await prisma.workspace.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        color: data.color,
        avatarUrl: data.avatarUrl,
        timezone: data.timezone ? data.timezone.trim() : undefined,
      },
    });

    await ActivityService.log({
      workspaceId: id,
      userId: actor.id,
      userName: (actor as any).name || 'Usuário',
      action: 'updated_workspace',
      details: { name: updated.name },
    });

    return updated;
  }

  static async archiveWorkspace(id: string, actor: Actor) {
    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundError('Workspace não encontrado.');

    await AccessService.assertCan(actor, 'archive_workspace', { workspaceId: workspace.id });
    await ShareService.revokeSharesForScope({ workspaceId: id });

    const updated = await prisma.workspace.update({
      where: { id },
      data: {
        isArchived: true,
        archivedAt: new Date(),
        archivedById: actor.id,
      },
    });

    await ActivityService.log({
      workspaceId: id,
      actor,
      action: 'workspace.archived',
      details: { name: updated.name },
    });

    return updated;
  }

  static async restoreWorkspace(id: string, actor: Actor) {
    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundError('Workspace não encontrado.');

    await AccessService.assertCan(actor, 'restore_workspace', { workspaceId: workspace.id });

    const updated = await prisma.workspace.update({
      where: { id },
      data: {
        isArchived: false,
        archivedAt: null,
        archivedById: null,
        deletedAt: null,
        deletedById: null,
        deletionReason: null,
      },
    });

    await ActivityService.log({
      workspaceId: id,
      actor,
      action: 'workspace.restored',
      details: { name: updated.name },
    });

    return updated;
  }

  static async deleteWorkspace(id: string, actor: Actor, reason?: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundError('Workspace não encontrado.');

    await AccessService.assertCan(actor, 'delete_workspace', { workspaceId: workspace.id });
    await ShareService.revokeSharesForScope({ workspaceId: id });

    const deleted = await prisma.workspace.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedById: actor.id,
        deletionReason: reason || null,
      },
    });

    await ActivityService.log({
      workspaceId: id,
      actor,
      action: 'workspace.deleted',
      details: { name: deleted.name, reason },
    });

    return deleted;
  }

  static async listMembers(
    workspaceId: string,
    actor: Actor,
    paginationQuery: { cursor?: string; limit?: string | number } = {}
  ) {
    await AccessService.assertCan(actor, 'read_workspace', { workspaceId });

    const { cursor, limit } = parsePaginationParams(paginationQuery);

    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
    });

    return buildCursorResponse(members, limit);
  }

  static async addMember(
    workspaceId: string,
    data: { userId: string; email: string; name: string; role?: WorkspaceRole; avatarUrl?: string },
    actor: Actor
  ) {
    await AccessService.assertCan(actor, 'manage_members', { workspaceId });

    return withWorkspaceLock(workspaceId, async (tx) => {
      // Verifica se já existe para evitar rebaixamento silencioso (X12 / E1.6-d)
      const existing = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: data.userId,
          },
        },
      });

      if (existing) {
        throw new ConflictError('Usuário já é membro deste workspace.');
      }

      const member = await tx.workspaceMember.create({
        data: {
          workspaceId,
          userId: data.userId,
          email: data.email,
          name: data.name,
          role: data.role || WorkspaceRole.MEMBER,
          avatarUrl: data.avatarUrl,
        },
      });

      await ActivityService.log(
        {
          workspaceId,
          userId: actor.id,
          userName: (actor as any).name || 'Usuário',
          action: 'added_member',
          details: { memberName: data.name, memberRole: member.role },
        },
        tx
      );

      return member;
    });
  }

  static async updateMemberRole(
    workspaceId: string,
    memberId: string,
    newRole: WorkspaceRole,
    actor: Actor
  ) {
    await AccessService.assertCan(actor, 'manage_members', { workspaceId });

    return withWorkspaceLock(workspaceId, async (tx) => {
      const member = await tx.workspaceMember.findUnique({
        where: { id: memberId },
      });

      if (!member || member.workspaceId !== workspaceId) {
        throw new NotFoundError('Membro não encontrado neste workspace.');
      }

      // Impede rebaixar o único ADMIN do workspace (E3.5-f / T05)
      if (member.role === WorkspaceRole.ADMIN && newRole !== WorkspaceRole.ADMIN) {
        const adminCount = await tx.workspaceMember.count({
          where: {
            workspaceId,
            role: WorkspaceRole.ADMIN,
            status: 'ACTIVE',
          },
        });

        if (adminCount <= 1) {
          throw new ForbiddenError(
            'Não é permitido rebaixar o único administrador do workspace. Promova outro membro a ADMIN antes.'
          );
        }
      }

      const updated = await tx.workspaceMember.update({
        where: { id: memberId },
        data: { role: newRole },
      });

      if (newRole === WorkspaceRole.VIEWER && member.role !== WorkspaceRole.VIEWER) {
        await ShareService.revokeSharesForScope({ workspaceId, userId: member.userId });
      }

      await ActivityService.log(
        {
          workspaceId,
          userId: actor.id,
          userName: (actor as any).name || 'Usuário',
          action: 'updated_member_role',
          details: { memberName: member.name, oldRole: member.role, newRole },
        },
        tx
      );

      return updated;
    });
  }

  static async removeMember(workspaceId: string, memberId: string, actor: Actor) {
    await AccessService.assertCan(actor, 'manage_members', { workspaceId });

    return withWorkspaceLock(workspaceId, async (tx) => {
      const member = await tx.workspaceMember.findUnique({
        where: { id: memberId },
      });

      if (!member || member.workspaceId !== workspaceId) {
        throw new NotFoundError('Membro não encontrado neste workspace.');
      }

      // Impede a remoção do último ADMIN (Seção 3.4 / E1.6-d / E3.5-f)
      if (member.role === WorkspaceRole.ADMIN) {
        const adminCount = await tx.workspaceMember.count({
          where: {
            workspaceId,
            role: WorkspaceRole.ADMIN,
            status: 'ACTIVE',
          },
        });

        if (adminCount <= 1) {
          throw new ForbiddenError(
            'Não é permitido remover o único administrador do workspace. Promova outro membro a ADMIN antes.'
          );
        }
      }

      await ShareService.revokeSharesForScope({ workspaceId, userId: member.userId });

      const deleted = await tx.workspaceMember.delete({
        where: { id: memberId },
      });

      await ActivityService.log(
        {
          workspaceId,
          userId: actor.id,
          userName: (actor as any).name || 'Usuário',
          action: 'removed_member',
          details: { memberName: member.name },
        },
        tx
      );

      return deleted;
    });
  }
}
