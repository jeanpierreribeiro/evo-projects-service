import fastify from 'fastify';
import cors from '@fastify/cors';

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
      api.get('/ping', async () => {
        return { message: 'evo-projects-service active' };
      });
    },
    { prefix: '/api/v1/projects' }
  );

  return app;
}
