import fastify from 'fastify';
import cors from '@fastify/cors';
import { workspacesRoutes } from './routes/workspaces.routes.js';
import { projectsRoutes } from './routes/projects.routes.js';
import { columnsRoutes } from './routes/columns.routes.js';
import { tasksRoutes } from './routes/tasks.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { inboxRoutes } from './routes/inbox.routes.js';
import { publicRoutes } from './routes/public.routes.js';

export function buildApp() {
  const app = fastify({
    logger: true,
  });

  // Enable CORS
  app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Healthcheck endpoint
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'evo-projects-service',
      engine: 'kaneo-headless',
      timestamp: new Date().toISOString(),
    };
  });

  // API v1 prefix
  app.register(
    async (api) => {
      // Public routes (Client validation portal)
      api.register(publicRoutes);

      // Authenticated routes
      api.register(workspacesRoutes);
      api.register(dashboardRoutes);
      api.register(inboxRoutes);
      api.register(projectsRoutes);
      api.register(columnsRoutes);
      api.register(tasksRoutes);
    },
    { prefix: '/api/v1/projects' }
  );

  return app;
}
