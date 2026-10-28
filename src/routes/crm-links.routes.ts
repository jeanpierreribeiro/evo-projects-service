import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CrmLinkService } from '../services/crm-link.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const contactLinkSchema = z
  .object({
    crmInstanceId: z.string().min(1),
    crmContactId: z.string().min(1),
    contactName: z.string().optional(),
    contactPhone: z.string().optional(),
    contactEmail: z.string().optional(),
  })
  .strict();

const inboxRouteSchema = z
  .object({
    crmInstanceId: z.string().min(1),
    crmInboxId: z.string().min(1),
    inboxName: z.string().optional(),
    isExclusive: z.boolean().optional(),
  })
  .strict();

const conversationContextSchema = z
  .object({
    projectId: z.string().min(1),
    crmInstanceId: z.string().min(1),
    crmConversationId: z.string().min(1),
    crmContactId: z.string().optional(),
    expiresInHours: z.number().int().positive().optional(),
  })
  .strict();

export async function crmLinksRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  const adminPolicy = {
    config: {
      policy: {
        action: 'manage_crm_links',
        resource: 'crm',
        minRole: 'ADMIN' as const,
      },
    },
  };

  // --- Contact Links ---
  fastify.get('/workspaces/:workspaceId/crm/contact-links', adminPolicy, async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const links = await CrmLinkService.listContactLinks(workspaceId, request.actor!);
    return { data: links };
  });

  fastify.post('/workspaces/:workspaceId/crm/contact-links', adminPolicy, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const parsed = contactLinkSchema.parse(request.body);
    const link = await CrmLinkService.createContactLink(workspaceId, parsed, request.actor!);
    return reply.status(201).send({ data: link });
  });

  fastify.delete('/crm/contact-links/:id', adminPolicy, async (request) => {
    const { id } = request.params as { id: string };
    await CrmLinkService.deleteContactLink(id, request.actor!);
    return { success: true };
  });

  // --- Inbox Routes ---
  fastify.get('/workspaces/:workspaceId/crm/inbox-routes', adminPolicy, async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const routes = await CrmLinkService.listInboxRoutes(workspaceId, request.actor!);
    return { data: routes };
  });

  fastify.post('/workspaces/:workspaceId/crm/inbox-routes', adminPolicy, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const parsed = inboxRouteSchema.parse(request.body);
    const route = await CrmLinkService.createInboxRoute(workspaceId, parsed, request.actor!);
    return reply.status(201).send({ data: route });
  });

  fastify.delete('/crm/inbox-routes/:id', adminPolicy, async (request) => {
    const { id } = request.params as { id: string };
    await CrmLinkService.deleteInboxRoute(id, request.actor!);
    return { success: true };
  });

  // --- Conversation Project Context ---
  fastify.post('/workspaces/:workspaceId/crm/conversation-context', adminPolicy, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const parsed = conversationContextSchema.parse(request.body);
    const ctx = await CrmLinkService.setConversationContext(workspaceId, parsed, request.actor!);
    return reply.status(201).send({ data: ctx });
  });

  // --- Diagnostics (E4.1-c) ---
  fastify.get('/workspaces/:workspaceId/crm/diagnostics', adminPolicy, async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const diag = await CrmLinkService.getDiagnostics(workspaceId, request.actor!);
    return { data: diag };
  });
}
