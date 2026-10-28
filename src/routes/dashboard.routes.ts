import { FastifyInstance } from 'fastify';
import prisma from '../db/prisma.js';
import { ProjectService } from '../services/project.service.js';
import { ActivityService } from '../services/activity.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { AccessService } from '../services/access.service.js';

export async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  fastify.get(
    '/workspaces/:workspaceId/dashboard',
    {
      config: {
        policy: {
          action: 'read_dashboard',
          resource: 'dashboard',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const actor = request.actor!;

      await AccessService.assertCan(actor, 'read_dashboard', { workspaceId });

      // 1. Projects with progress %
      const projectsResult = await ProjectService.listByWorkspace(workspaceId, actor);
      const projects = Array.isArray(projectsResult) ? projectsResult : (projectsResult?.data || []);

      // 2. Aggregated stats
      const totalProjects = projects.length;
      const totalTasks = projects.reduce((acc: number, p: any) => acc + (p.totalTasks || 0), 0);
      const completedTasks = projects.reduce((acc: number, p: any) => acc + (p.completedTasks || 0), 0);
      const overallProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      // 3. Upcoming tasks (com prazo, ordenadas por atraso/vencimento, prioridade e ID - E3.8-d)
      const tasksWithDueDate = await prisma.task.findMany({
        where: {
          workspaceId,
          isArchived: false,
          deletedAt: null,
          dueDate: { not: null },
          column: { isDoneColumn: false },
          project: { isArchived: false, deletedAt: null },
        },
        include: {
          project: { select: { id: true, name: true, color: true, key: true } },
          column: { select: { id: true, name: true, color: true } },
          subtasks: { select: { id: true, completed: true } },
        },
      });

      const priorityOrder: Record<string, number> = {
        URGENT: 4,
        HIGH: 3,
        MEDIUM: 2,
        LOW: 1,
        NONE: 0,
      };

      tasksWithDueDate.sort((a, b) => {
        const dateA = a.dueDate ? new Date(a.dueDate).getTime() : 0;
        const dateB = b.dueDate ? new Date(b.dueDate).getTime() : 0;
        if (dateA !== dateB) return dateA - dateB;

        const prioA = priorityOrder[a.priority] ?? 0;
        const prioB = priorityOrder[b.priority] ?? 0;
        if (prioA !== prioB) return prioB - prioA;

        return a.taskNumber - b.taskNumber;
      });

      const upcomingTasks = tasksWithDueDate.slice(0, 6).map((t) => {
        const totalSub = t.subtasks.length;
        const compSub = t.subtasks.filter((s) => s.completed).length;
        const subtaskProgress = totalSub > 0 ? Math.round((compSub / totalSub) * 100) : 0;
        const { subtasks, ...rest } = t;
        return {
          ...rest,
          totalSubtasks: totalSub,
          completedSubtasks: compSub,
          subtaskProgress,
        };
      });

      // 4. Tarefas ativas sem prazo (grupo separado sem prazo fabricado - E3.8-d / Seção 6.6)
      const tasksWithoutDueDate = await prisma.task.findMany({
        where: {
          workspaceId,
          isArchived: false,
          deletedAt: null,
          dueDate: null,
          column: { isDoneColumn: false },
          project: { isArchived: false, deletedAt: null },
        },
        take: 6,
        orderBy: [{ priority: 'desc' }, { taskNumber: 'asc' }],
        include: {
          project: { select: { id: true, name: true, color: true, key: true } },
          column: { select: { id: true, name: true, color: true } },
        },
      });

      // 5. Activity feed
      const activities = await ActivityService.listByWorkspace(workspaceId, 15);

      return {
        data: {
          stats: {
            totalProjects,
            totalTasks,
            completedTasks,
            openTasks: totalTasks - completedTasks,
            overallProgress,
          },
          projects,
          upcomingTasks,
          tasksWithoutDueDate,
          activities,
        },
      };
    }
  );

  // GET /workspaces/:workspaceId/activities - Feed de atividades com paginação por cursor (E3.1-c)
  fastify.get(
    '/workspaces/:workspaceId/activities',
    {
      config: {
        policy: {
          action: 'read_dashboard',
          resource: 'dashboard',
          minRole: 'VIEWER',
        },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const actor = request.actor!;
      const query = request.query as any;

      await AccessService.assertCan(actor, 'read_dashboard', { workspaceId });
      return ActivityService.listPaginatedByWorkspace(workspaceId, query);
    }
  );
}
