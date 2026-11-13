import fastify, { FastifyInstance, RouteOptions } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { config } from './config/env.js';
import { RouteInventoryEntry } from './types/route-inventory.js';
import { workspacesRoutes } from './routes/workspaces.routes.js';
import { projectsRoutes } from './routes/projects.routes.js';
import { columnsRoutes } from './routes/columns.routes.js';
import { tasksRoutes } from './routes/tasks.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { inboxRoutes } from './routes/inbox.routes.js';
import { integrationsRoutes } from './routes/integrations.routes.js';
import { shareRoutes } from './routes/shares.routes.js';
import { labelsRoutes } from './routes/labels.routes.js';
import { customFieldsRoutes } from './routes/custom-fields.routes.js';
import { attachmentsRoutes } from './routes/attachments.routes.js';
import { crmLinksRoutes } from './routes/crm-links.routes.js';
import { publicShareRoutes } from './routes/public-shares.routes.js';
import { publicRoutes } from './routes/public.routes.js';
import { mcpRoutes } from './routes/mcp.routes.js';
import { errorHandler } from './errors/error-handler.js';
import prisma from './db/prisma.js';

declare module 'fastify' {
  interface FastifyInstance {
    routeInventory?: RouteInventoryEntry[];
  }
}

export function buildApp() {
  const app = fastify({
    logger: true,
    bodyLimit: 10 * 1024 * 1024, // Limite estrito de 10MB por corpo (E1.8-a)
    trustProxy: ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], // Proxies confiáveis (E1.8-a)
  });

  // Cabeçalhos de segurança HTTP essenciais (E1.8-a)
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!reply.getHeader('X-Frame-Options')) reply.header('X-Frame-Options', 'DENY');
    if (!reply.getHeader('Referrer-Policy')) reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-XSS-Protection', '1; mode=block');
  });


  const routeInventory: RouteInventoryEntry[] = [];
  app.routeInventory = routeInventory;

  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      const cfg = (routeOptions.config || {}) as any;
      routeInventory.push({
        method: m,
        url: routeOptions.url,
        action: cfg.policy?.action || cfg.action || 'pendente',
        policy: cfg.policy ? JSON.stringify(cfg.policy) : 'pendente',
        isPublic: cfg.isPublic ?? (routeOptions.url.startsWith('/public') || routeOptions.url === '/health' || routeOptions.url === '/ready'),
      });
    }
  });

  // Enable CORS com lista explícita (E1.2-e / S4 / F4)
  app.register(cors, {
    origin: (origin, cb) => {
      // Requisições sem cabeçalho Origin (ex: server-to-server, healthchecks, curl)
      if (!origin) return cb(null, true);
      if (config.corsOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Origem não permitida pela política CORS'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  app.setErrorHandler((error: any, request, reply) => {
    if (error?.message?.includes('Origem não permitida pela política CORS')) {
      return reply.status(403).send({
        code: 'FORBIDDEN_ORIGIN',
        message: 'Origem não permitida pela política CORS.',
        requestId: request.id,
      });
    }
    return errorHandler(error, request, reply);
  });

  // Enable Cookies para sessão pública do PIN (E2.3-b)
  app.register(cookie);

  // Enable Multipart para upload seguro de anexos com streaming (E3.7-b / E3.7-f)
  app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024, // 25 MiB permitidos no multipart para acomodar margem de metadados
      files: 1,
    },
  });

  // Healthcheck endpoint (E1.8-c)
  app.get(
    '/health',
    {
      config: {
        isPublic: true,
        policy: {
          action: 'health_check',
          resource: 'system',
        },
      },
    },
    async () => {
      return {
        status: 'ok',
        service: 'evo-projects-service',
        engine: 'kaneo-headless',
        timestamp: new Date().toISOString(),
      };
    }
  );

  // Readiness endpoint (E1.8-c)
  app.get(
    '/ready',
    {
      config: {
        isPublic: true,
        policy: {
          action: 'readiness_check',
          resource: 'system',
        },
      },
    },
    async (request, reply) => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return {
          status: 'ready',
          database: 'connected',
          timestamp: new Date().toISOString(),
        };
      } catch (err) {
        return reply.status(503).send({
          status: 'not_ready',
          database: 'disconnected',
          timestamp: new Date().toISOString(),
        });
      }
    }
  );

  // MCP Server routes for AI and Bot Runtime at root (/mcp) (E4.3-a)
  app.register(mcpRoutes);

  // API v1 prefix
  app.register(
    async (api) => {
      // Public routes (Client validation portal - 410 Gone)
      api.register(publicRoutes);

      // Public Task Sharing with PIN (Phase 2 - E2.3)
      api.register(publicShareRoutes);

      // MCP Server routes for AI and Bot Runtime (503 when disabled)
      api.register(mcpRoutes);

      // Authenticated routes
      api.register(workspacesRoutes);
      api.register(integrationsRoutes);
      api.register(dashboardRoutes);
      api.register(inboxRoutes);
      api.register(projectsRoutes);
      api.register(columnsRoutes);
      api.register(tasksRoutes);
      api.register(labelsRoutes);
      api.register(customFieldsRoutes);
      api.register(attachmentsRoutes);
      api.register(crmLinksRoutes);
      api.register(shareRoutes);
    },
    { prefix: '/api/v1/projects' }
  );

  return app;
}
