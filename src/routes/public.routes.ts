import { FastifyInstance } from 'fastify';

/**
 * Rotas públicas legadas de aprovação (Contenção E1.2-c)
 * Todas as ações antigas de aprovação/rejeição/preview retornam 410 LEGACY_FEATURE_REMOVED.
 * O novo compartilhamento de leitura por PIN será introduzido na Fase 2 (/public/shares/:token/*).
 */
export async function publicRoutes(fastify: FastifyInstance) {
  const legacyRemovedHandler = async (request: any, reply: any) => {
    return reply.status(410).send({
      code: 'LEGACY_FEATURE_REMOVED',
      message: 'O portal legado de aprovação foi descontinuado e substituído pelo compartilhamento de leitura.',
      requestId: request.id,
    });
  };

  const routeConfig = {
    config: {
      isPublic: true,
      policy: {
        action: 'legacy_public_portal',
        resource: 'legacy_approval',
      },
    },
  };

  // GET /public/tasks/:token/preview
  fastify.get('/public/tasks/:token/preview', routeConfig, legacyRemovedHandler);

  // POST /public/tasks/:token/validate-pin
  fastify.post('/public/tasks/:token/validate-pin', routeConfig, legacyRemovedHandler);

  // POST /public/tasks/:token/approve
  fastify.post('/public/tasks/:token/approve', routeConfig, legacyRemovedHandler);

  // POST /public/tasks/:token/request-changes
  fastify.post('/public/tasks/:token/request-changes', routeConfig, legacyRemovedHandler);
}
