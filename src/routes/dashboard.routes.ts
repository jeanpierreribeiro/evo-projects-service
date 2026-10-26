import { FastifyInstance } from 'fastify';
import prisma from '../db/prisma.js';
import { ProjectService } from '../services/project.service.js';
import { ActivityService } from '../services/activity.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

export async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  fastify.get('/workspaces/:workspaceId/dashboard', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const user = request.user!;

    // 1. Projects with progress %
    const projects = await ProjectService.listByWorkspace(workspaceId);

    // 2. Aggregated stats
    const totalProjects = projects.length;
    const totalTasks = projects.reduce((acc, p) => acc + p.totalTasks, 0);
    const completedTasks = projects.reduce((acc, p) => acc + p.completedTasks, 0);
    const overallProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // 3. Upcoming tasks (due soon or high priority)
    const upcomingTasks = await prisma.task.findMany({
      where: {
        workspaceId,
        isArchived: false,
        column: { isDoneColumn: false },
      },
      orderBy: [
        { dueDate: 'asc' },
        { priority: 'desc' },
      ],
      take: 6,
      include: {
        project: { select: { id: true, name: true, color: true } },
        column: { select: { id: true, name: true, color: true } },
      },
    });

    // 4. Activity feed
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
        activities,
      },
    };
  });
}
