import prisma from '../db/prisma.js';
import { ActivityService } from './activity.service.js';
import { AccessService } from './access.service.js';
import { ShareService } from './share.service.js';
import { Actor } from '../types/auth.js';
import { NotFoundError, ValidationError, ConflictError } from '../errors/app-error.js';
import { parsePaginationParams, buildCursorResponse } from '../utils/pagination.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

export class ProjectService {
  static async listByWorkspace(
    workspaceId: string,
    actor: Actor,
    includeArchived = false,
    paginationQuery: { cursor?: string; limit?: string | number } = {}
  ) {
    await AccessService.assertCan(actor, 'read_project', { workspaceId });
    const { cursor, limit } = parsePaginationParams(paginationQuery);

    const projects = await prisma.project.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      include: {
        columns: {
          orderBy: { position: 'asc' },
          select: { id: true, name: true, isDoneColumn: true },
        },
        _count: {
          select: { tasks: true },
        },
      },
    });

    // Compute progress % for each project
    const projectsWithProgress = await Promise.all(
      projects.map(async (project) => {
        const doneColumns = project.columns.filter((c) => c.isDoneColumn).map((c) => c.id);

        // Exclui estritamente arquivadas e com soft-delete das métricas operacionais (E3.8-d / Seção 6.6)
        const totalTasks = await prisma.task.count({
          where: {
            projectId: project.id,
            isArchived: false,
            deletedAt: null,
          },
        });

        let completedTasks = 0;
        if (totalTasks > 0 && doneColumns.length > 0) {
          completedTasks = await prisma.task.count({
            where: {
              projectId: project.id,
              columnId: { in: doneColumns },
              isArchived: false,
              deletedAt: null,
            },
          });
        }

        const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

        return {
          ...project,
          totalTasks,
          completedTasks,
          progress,
        };
      })
    );

    return buildCursorResponse(projectsWithProgress, limit);
  }

  static async createProject(
    workspaceId: string,
    data: {
      name: string;
      key?: string;
      description?: string;
      color?: string;
      icon?: string;
      backlogColumnId?: string;
    },
    actor: Actor
  ) {
    await AccessService.assertCan(actor, 'create_project', { workspaceId });

    let slug = slugify(data.name);
    let count = 1;
    while (await prisma.project.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } })) {
      slug = `${slugify(data.name)}-${count++}`;
    }

    // Validação e resolução de chave de projeto (E3.3-c / T12)
    let key = data.key?.trim()?.toUpperCase();
    if (key) {
      if (!/^[A-Z0-9]{2,10}$/.test(key)) {
        throw new ValidationError('A chave do projeto deve ter entre 2 e 10 caracteres alfanuméricos maiúsculos (ex: PROJ, ALF, DEV).');
      }
      const existingKey = await prisma.project.findUnique({
        where: { workspaceId_key: { workspaceId, key } },
      });
      if (existingKey) {
        throw new ConflictError('A chave informada já está em uso neste workspace.');
      }
    } else {
      const candidate = data.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      const baseKey = candidate.length >= 2 ? candidate : 'PRJ';
      key = baseKey;
      let countKey = 1;
      while (await prisma.project.findUnique({ where: { workspaceId_key: { workspaceId, key } } })) {
        key = `${baseKey.slice(0, 6)}${countKey++}`;
      }
    }

    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: data.name,
        slug,
        key,
        taskCounter: 0,
        description: data.description,
        color: data.color || '#6366f1',
        icon: data.icon || 'folder',
        columns: {
          create: [
            { name: 'Backlog', position: 0, color: '#94a3b8', isDoneColumn: false },
            { name: 'A Fazer', position: 1, color: '#3b82f6', isDoneColumn: false },
            { name: 'Em Andamento', position: 2, color: '#f59e0b', isDoneColumn: false },
            { name: 'Em Revisão', position: 3, color: '#8b5cf6', isDoneColumn: false },
            { name: 'Concluído', position: 4, color: '#10b981', isDoneColumn: true },
          ],
        },
      },
      include: {
        columns: {
          orderBy: { position: 'asc' },
        },
      },
    });

    // Configura backlogColumnId padrão se não fornecido
    const backlogCol = project.columns.find((c) => c.name === 'Backlog') || project.columns[0];
    if (backlogCol && !project.backlogColumnId) {
      await prisma.project.update({
        where: { id: project.id },
        data: { backlogColumnId: data.backlogColumnId || backlogCol.id },
      });
      (project as any).backlogColumnId = data.backlogColumnId || backlogCol.id;
    }

    await ActivityService.log({
      workspaceId,
      projectId: project.id,
      userId: actor.id,
      userName: (actor as any).name || 'Usuário',
      action: 'created_project',
      details: { projectName: project.name, projectKey: project.key },
    });

    return project;
  }

  static async getProject(id: string, actor: Actor, expectedWorkspaceId?: string) {
    return AccessService.getAuthorizedProject(id, actor, 'read_project', expectedWorkspaceId);
  }

  static async updateProject(
    id: string,
    data: {
      name?: string;
      key?: string;
      backlogColumnId?: string | null;
      description?: string;
      color?: string;
      icon?: string;
      isArchived?: boolean;
    },
    actor: Actor
  ) {
    const existing = await AccessService.getAuthorizedProject(id, actor, 'manage_project');

    const updateData: any = { ...data };

    // Validação de imutabilidade e formato de key (E3.3-c / T12)
    if (data.key !== undefined) {
      const newKey = data.key.trim().toUpperCase();
      if (newKey !== existing.key) {
        const taskCount = await prisma.task.count({ where: { projectId: id } });
        if (taskCount > 0) {
          throw new ValidationError('A chave do projeto é imutável após a criação de tarefas.');
        }
        if (!/^[A-Z0-9]{2,10}$/.test(newKey)) {
          throw new ValidationError('A chave do projeto deve ter entre 2 e 10 caracteres alfanuméricos maiúsculos.');
        }
        const conflict = await prisma.project.findUnique({
          where: { workspaceId_key: { workspaceId: existing.workspaceId, key: newKey } },
        });
        if (conflict) {
          throw new ConflictError('A chave informada já está em uso neste workspace.');
        }
        updateData.key = newKey;
      }
    }

    // Validação de backlogColumnId (E3.3-b)
    if (data.backlogColumnId !== undefined && data.backlogColumnId !== null) {
      const col = await prisma.column.findFirst({
        where: { id: data.backlogColumnId, projectId: id },
      });
      if (!col) {
        throw new NotFoundError('Coluna de backlog não encontrada neste projeto.');
      }
      if (col.isDoneColumn) {
        throw new ValidationError('A coluna de backlog não pode ser uma coluna de conclusão (isDoneColumn).');
      }
    }

    const project = await prisma.project.update({
      where: { id },
      data: updateData,
    });

    await ActivityService.log({
      workspaceId: existing.workspaceId,
      projectId: project.id,
      userId: actor.id,
      userName: (actor as any).name || 'Usuário',
      action: 'updated_project',
      details: { projectName: project.name, projectKey: project.key },
    });

    return project;
  }

  static async archiveProject(id: string, actor: Actor) {
    const existing = await AccessService.getAuthorizedProject(id, actor, 'archive_project');

    await ShareService.revokeSharesForScope({ projectId: id });

    const updated = await prisma.project.update({
      where: { id },
      data: {
        isArchived: true,
        archivedAt: new Date(),
        archivedById: actor.id,
      },
    });

    await ActivityService.log({
      workspaceId: existing.workspaceId,
      projectId: id,
      actor,
      action: 'project.archived',
      details: { projectName: updated.name, projectKey: updated.key },
    });

    return updated;
  }

  static async restoreProject(id: string, actor: Actor) {
    const existing = await AccessService.getAuthorizedProject(id, actor, 'restore_project');

    const updated = await prisma.project.update({
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
      workspaceId: existing.workspaceId,
      projectId: id,
      actor,
      action: 'project.restored',
      details: { projectName: updated.name, projectKey: updated.key },
    });

    return updated;
  }

  static async deleteProject(id: string, actor: Actor, reason?: string) {
    const existing = await AccessService.getAuthorizedProject(id, actor, 'delete_project');

    await ShareService.revokeSharesForScope({ projectId: id });

    const project = await prisma.project.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedById: actor.id,
        deletionReason: reason || null,
      },
    });

    await ActivityService.log({
      workspaceId: existing.workspaceId,
      projectId: id,
      actor,
      action: 'project.deleted',
      details: { projectName: project.name, reason },
    });

    return project;
  }
}
