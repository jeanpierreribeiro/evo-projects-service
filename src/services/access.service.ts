import prisma from '../db/prisma.js';
import { Actor, WorkspaceRoleType } from '../types/auth.js';
import { ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { WorkspaceRole } from '@prisma/client';

export interface AccessCheckContext {
  workspaceId: string;
  authorId?: string;
  targetUserId?: string;
  isProjectArchived?: boolean;
  isWorkspaceArchived?: boolean;
}

export interface AccessDecision {
  allowed: boolean;
  role?: WorkspaceRoleType;
  reason?: string;
}

/**
 * AccessService - Camada única e central de autorização (E1.4 / Seção 3.2 e 3.3)
 * Avalia ator + ação + recurso + vínculo/autoria.
 * Garante isolamento estrito entre workspaces e ausência de bypass por super_admin.
 */
export class AccessService {
  /**
   * Obtém a associação ativa de um ator com um workspace.
   * Não aplica bypass por super_admin (Seção 3.5).
   */
  static async getMembership(
    workspaceId: string,
    actor: Actor
  ): Promise<{ role: WorkspaceRoleType; active: boolean } | null> {
    if (!workspaceId || !actor) return null;

    if (actor.type === 'user') {
      const member = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: actor.id,
          },
        },
        select: {
          role: true,
        },
      });

      if (!member) return null;
      return { role: member.role as WorkspaceRoleType, active: true };
    }

    // Para service principals (E1.7)
    if (actor.type === 'service') {
      const grant = await prisma.integrationGrant.findFirst({
        where: {
          principalId: actor.id,
          workspaceId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });

      if (!grant) return null;
      return { role: 'MEMBER', active: true };
    }

    // Para sessões públicas de PIN (Fase 2)
    if (actor.type === 'shareSession') {
      if (actor.workspaceId === workspaceId) {
        return { role: 'VIEWER', active: true };
      }
      return null;
    }

    return null;
  }

  /**
   * Avalia permissão de acordo com a matriz da Seção 3.3.
   */
  static async can(
    actor: Actor,
    action: string,
    context: AccessCheckContext
  ): Promise<AccessDecision> {
    if (!actor || !context?.workspaceId) {
      return { allowed: false, reason: 'INVALID_CONTEXT' };
    }

    const membership = await this.getMembership(context.workspaceId, actor);
    if (!membership || !membership.active) {
      return { allowed: false, reason: 'NOT_MEMBER' };
    }

    const role = membership.role;

    // Regra especial: Notificações / Inbox privado (E1.4-d)
    // Notificações pertencem estritamente ao destinatário; ADMIN não acessa inbox alheio.
    if (action === 'read_own_notifications' || action === 'manage_own_notifications') {
      if (context.targetUserId && context.targetUserId !== actor.id) {
        return {
          allowed: false,
          role,
          reason: 'INBOX_PRIVATE_TO_RECIPIENT',
        };
      }
      return { allowed: true, role };
    }

    // Ações administrativas exclusivas (ADMIN)
    const adminOnlyActions = [
      'manage_workspace',
      'archive_workspace',
      'restore_workspace',
      'delete_workspace',
      'manage_members',
      'create_project',
      'manage_project',
      'archive_project',
      'restore_project',
      'delete_project',
      'manage_columns',
      'manage_tags',
      'manage_labels',
      'manage_custom_fields',
      'manage_crm_links',
      'delete_task',
    ];

    if (adminOnlyActions.includes(action)) {
      if (role === 'ADMIN') return { allowed: true, role };
      return { allowed: false, role, reason: 'REQUIRES_ADMIN' };
    }

    // Ações com regra de autoria (MEMBER próprio / ADMIN todos)
    if (
      action === 'edit_comment' ||
      action === 'delete_comment' ||
      action === 'edit_time_entry' ||
      action === 'delete_time_entry' ||
      action === 'manage_share'
    ) {
      if (role === 'ADMIN') return { allowed: true, role };
      if (role === 'MEMBER') {
        if (context.authorId && context.authorId === actor.id) {
          return { allowed: true, role };
        }
        return { allowed: false, role, reason: 'NOT_RESOURCE_AUTHOR' };
      }
      return { allowed: false, role, reason: 'VIEWER_CANNOT_WRITE' };
    }

    // Arquivar / Restaurar tarefas
    if (action === 'archive_task' || action === 'restore_task') {
      if (role === 'ADMIN') return { allowed: true, role };
      if (role === 'MEMBER') {
        // Restaurar tarefa com projeto ou workspace arquivado exige ADMIN
        if (context.isWorkspaceArchived || context.isProjectArchived) {
          return { allowed: false, role, reason: 'ARCHIVED_PARENT_REQUIRES_ADMIN' };
        }
        return { allowed: true, role };
      }
      return { allowed: false, role, reason: 'VIEWER_CANNOT_WRITE' };
    }

    // Ações de escrita e colaboração (MEMBER e ADMIN)
    const memberWriteActions = [
      'create_task',
      'edit_task',
      'move_task',
      'create_subtask',
      'edit_subtask',
      'delete_subtask',
      'create_relation',
      'delete_relation',
      'create_resource',
      'delete_resource',
      'create_comment',
      'create_time_entry',
      'share_task',
      'transfer_task',
    ];

    if (memberWriteActions.includes(action)) {
      if (role === 'ADMIN' || role === 'MEMBER') {
        return { allowed: true, role };
      }
      return { allowed: false, role, reason: 'VIEWER_CANNOT_WRITE' };
    }

    // Ações de leitura (VIEWER, MEMBER, ADMIN)
    const readActions = [
      'read_workspace',
      'read_project',
      'read_column',
      'read_task',
      'read_label',
      'read_operational_history',
      'read_internal_comments',
      'read_dashboard',
    ];

    if (readActions.includes(action)) {
      return { allowed: true, role };
    }

    return { allowed: false, role, reason: 'UNKNOWN_ACTION' };
  }

  /**
   * Assegura autorização, lançando NotFoundError (quando fora do workspace)
   * ou ForbiddenError (quando papel insuficiente).
   */
  static async assertCan(
    actor: Actor,
    action: string,
    context: AccessCheckContext
  ): Promise<WorkspaceRoleType> {
    const decision = await this.can(actor, action, context);
    if (!decision.allowed) {
      if (decision.reason === 'NOT_MEMBER') {
        // 404 para não vazar a existência do recurso fora do alcance do usuário (Seção 3.2)
        throw new NotFoundError('Recurso não encontrado ou fora do alcance do usuário.');
      }
      if (decision.reason === 'INBOX_PRIVATE_TO_RECIPIENT') {
        throw new ForbiddenError('Notificações são estritamente privadas do destinatário.');
      }
      throw new ForbiddenError(
        `Permissão insuficiente para a ação "${action}" no workspace (papel atual: ${decision.role || 'nenhum'}).`
      );
    }
    return decision.role!;
  }

  /**
   * Resolução e validação de pertencimento: Workspace
   */
  static async getAuthorizedWorkspace(
    workspaceId: string,
    actor: Actor,
    action = 'read_workspace'
  ) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace não encontrado.');
    }

    if (workspace.deletedAt && action !== 'restore_workspace') {
      throw new NotFoundError('Workspace não encontrado.');
    }

    const readOnlyActions = ['read_workspace', 'read_operational_history', 'restore_workspace'];
    if (workspace.isArchived && !readOnlyActions.includes(action)) {
      throw new ForbiddenError('O workspace está arquivado e em modo somente leitura.');
    }

    await this.assertCan(actor, action, {
      workspaceId: workspace.id,
      isWorkspaceArchived: workspace.isArchived,
    });
    return workspace;
  }

  /**
   * Resolução e validação de pertencimento: Project
   * Comprova vínculo pai-filho caso expectedWorkspaceId seja informado.
   */
  static async getAuthorizedProject(
    projectId: string,
    actor: Actor,
    action = 'read_project',
    expectedWorkspaceId?: string
  ) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        workspace: {
          select: { id: true, isArchived: true, deletedAt: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundError('Projeto não encontrado.');
    }

    if (expectedWorkspaceId && project.workspaceId !== expectedWorkspaceId) {
      throw new NotFoundError('Projeto não pertence ao workspace informado.');
    }

    // Se o workspace pai foi excluído logicamente, o projeto fica inacessível
    if (project.workspace?.deletedAt) {
      throw new NotFoundError('Projeto não encontrado.');
    }

    // Se o próprio projeto foi excluído logicamente
    if (project.deletedAt && action !== 'restore_project') {
      throw new NotFoundError('Projeto não encontrado.');
    }

    const readOnlyActions = ['read_project', 'read_operational_history', 'restore_project'];
    if (project.workspace?.isArchived && !readOnlyActions.includes(action)) {
      throw new ForbiddenError('O container do projeto está arquivado e em modo somente leitura.');
    }

    if (project.isArchived && !readOnlyActions.includes(action)) {
      throw new ForbiddenError('O projeto está arquivado e em modo somente leitura.');
    }

    await this.assertCan(actor, action, {
      workspaceId: project.workspaceId,
      isProjectArchived: project.isArchived,
      isWorkspaceArchived: project.workspace?.isArchived,
    });

    return project;
  }

  /**
   * Resolução e validação de pertencimento: Column
   * Comprova vínculo com o projeto e workspace.
   */
  static async getAuthorizedColumn(
    columnId: string,
    actor: Actor,
    action = 'manage_columns',
    expectedProjectId?: string
  ) {
    const column = await prisma.column.findUnique({
      where: { id: columnId },
      include: {
        project: {
          select: {
            id: true,
            workspaceId: true,
            isArchived: true,
            deletedAt: true,
            workspace: {
              select: { id: true, isArchived: true, deletedAt: true },
            },
          },
        },
      },
    });

    if (!column) {
      throw new NotFoundError('Coluna não encontrada.');
    }

    if (expectedProjectId && column.projectId !== expectedProjectId) {
      throw new NotFoundError('Coluna não pertence ao projeto informado.');
    }

    if (column.project.workspace.deletedAt || column.project.deletedAt) {
      throw new NotFoundError('Coluna não encontrada.');
    }

    if (column.project.workspace.isArchived || column.project.isArchived) {
      throw new ForbiddenError('O projeto está arquivado e em modo somente leitura.');
    }

    await this.assertCan(actor, action, {
      workspaceId: column.project.workspaceId,
      isProjectArchived: column.project.isArchived,
      isWorkspaceArchived: column.project.workspace.isArchived,
    });

    return column;
  }

  /**
   * Resolução e validação de pertencimento: Task
   * Comprova vínculo com workspace e projeto.
   */
  static async getAuthorizedTask(
    taskId: string,
    actor: Actor,
    action = 'read_task',
    expectedWorkspaceId?: string,
    expectedProjectId?: string
  ) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: {
            id: true,
            workspaceId: true,
            isArchived: true,
            deletedAt: true,
            workspace: {
              select: { id: true, isArchived: true, deletedAt: true },
            },
          },
        },
      },
    });

    if (!task) {
      throw new NotFoundError('Tarefa não encontrada.');
    }

    if (expectedWorkspaceId && task.workspaceId !== expectedWorkspaceId) {
      throw new NotFoundError('Tarefa não pertence ao workspace informado.');
    }

    if (expectedProjectId && task.projectId !== expectedProjectId) {
      throw new NotFoundError('Tarefa não pertence ao projeto informado.');
    }

    // Se o workspace ou o projeto pai foi excluído logicamente, a tarefa fica invisível
    if (task.project?.workspace?.deletedAt || task.project?.deletedAt) {
      throw new NotFoundError('Tarefa não encontrada.');
    }

    // Se a própria tarefa foi excluída logicamente
    if (task.deletedAt && action !== 'restore_task') {
      throw new NotFoundError('Tarefa não encontrada.');
    }

    const readOnlyActions = [
      'read_task',
      'read_internal_comments',
      'read_operational_history',
      'restore_task',
    ];

    // Se o workspace ou o projeto pai estiver arquivado
    const isParentArchived = Boolean(
      task.project?.workspace?.isArchived || task.project?.isArchived
    );
    if (isParentArchived && !readOnlyActions.includes(action)) {
      throw new ForbiddenError(
        'O container da tarefa está arquivado e em modo somente leitura.'
      );
    }

    // Se a tarefa em si estiver arquivada
    if (task.isArchived && !readOnlyActions.includes(action)) {
      throw new ForbiddenError('A tarefa está arquivada e em modo somente leitura.');
    }

    const role = await this.assertCan(actor, action, {
      workspaceId: task.workspaceId,
      isProjectArchived: task.project?.isArchived,
      isWorkspaceArchived: task.project?.workspace?.isArchived,
    });

    // Se a tarefa foi excluída logicamente, restaurá-la exige estritamente papel ADMIN
    if (task.deletedAt && action === 'restore_task' && role !== 'ADMIN') {
      throw new ForbiddenError('Apenas administradores podem restaurar tarefas excluídas.');
    }

    return task;
  }

  /**
   * Resolução e validação de pertencimento: Label (E3.3-a)
   * Comprova vínculo com workspace.
   */
  static async getAuthorizedLabel(
    labelId: string,
    actor: Actor,
    action = 'manage_labels',
    expectedWorkspaceId?: string
  ) {
    const label = await prisma.label.findUnique({
      where: { id: labelId },
    });

    if (!label) {
      throw new NotFoundError('Etiqueta não encontrada.');
    }

    if (expectedWorkspaceId && label.workspaceId !== expectedWorkspaceId) {
      throw new NotFoundError('Etiqueta não pertence ao workspace informado.');
    }

    await this.assertCan(actor, action, {
      workspaceId: label.workspaceId,
    });

    return label;
  }
}
