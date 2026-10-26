import prisma from '../db/prisma.js';
import { ActivityService } from './activity.service.js';

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
  static async listByWorkspace(workspaceId: string, includeArchived = false) {
    const projects = await prisma.project.findMany({
      where: {
        workspaceId,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: { createdAt: 'desc' },
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
        const totalTasks = project._count.tasks;
        let completedTasks = 0;

        if (totalTasks > 0 && doneColumns.length > 0) {
          completedTasks = await prisma.task.count({
            where: {
              projectId: project.id,
              columnId: { in: doneColumns },
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

    return projectsWithProgress;
  }

  static async createProject(
    workspaceId: string,
    data: { name: string; description?: string; color?: string; icon?: string },
    actor: { id: string; name: string }
  ) {
    let slug = slugify(data.name);
    let count = 1;
    while (await prisma.project.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } })) {
      slug = `${slugify(data.name)}-${count++}`;
    }

    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: data.name,
        slug,
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

    await ActivityService.log({
      workspaceId,
      projectId: project.id,
      userId: actor.id,
      userName: actor.name,
      action: 'created_project',
      details: { projectName: project.name },
    });

    return project;
  }

  static async getProject(id: string) {
    return prisma.project.findFirst({
      where: {
        OR: [{ id }],
      },
      include: {
        columns: {
          orderBy: { position: 'asc' },
        },
        customFields: true,
        workspace: {
          select: { id: true, name: true, slug: true },
        },
        _count: {
          select: { tasks: true },
        },
      },
    });
  }

  static async updateProject(
    id: string,
    data: { name?: string; description?: string; color?: string; icon?: string; isArchived?: boolean },
    actor: { id: string; name: string }
  ) {
    const project = await prisma.project.update({
      where: { id },
      data,
    });

    await ActivityService.log({
      workspaceId: project.workspaceId,
      projectId: project.id,
      userId: actor.id,
      userName: actor.name,
      action: 'updated_project',
      details: { projectName: project.name },
    });

    return project;
  }

  static async deleteProject(id: string, actor: { id: string; name: string }) {
    const project = await prisma.project.delete({
      where: { id },
    });

    await ActivityService.log({
      workspaceId: project.workspaceId,
      userId: actor.id,
      userName: actor.name,
      action: 'deleted_project',
      details: { projectName: project.name },
    });

    return project;
  }
}
