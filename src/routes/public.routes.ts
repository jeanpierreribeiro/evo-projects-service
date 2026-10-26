import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalService } from '../services/approval.service.js';

const pinSchema = z.object({
  pin: z.string().min(4, 'PIN deve ter ao menos 4 dígitos'),
});

const requestChangesSchema = pinSchema.extend({
  feedback: z.string().min(1, 'Por favor, descreva os ajustes necessários'),
});

export async function publicRoutes(fastify: FastifyInstance) {
  // GET /public/tasks/:token/preview - Basic preview before entering PIN
  fastify.get('/public/tasks/:token/preview', async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const preview = await ApprovalService.getPublicPreview(token);
      return { data: preview };
    } catch (err: any) {
      return reply.status(404).send({ error: err.message || 'Link inválido' });
    }
  });

  // POST /public/tasks/:token/validate-pin - Unlock delivery details
  fastify.post('/public/tasks/:token/validate-pin', async (request, reply) => {
    const { token } = request.params as { token: string };
    const parsed = pinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'PIN inválido' });
    }

    try {
      const details = await ApprovalService.validatePin(token, parsed.data.pin);
      return { data: details };
    } catch (err: any) {
      return reply.status(401).send({ error: err.message || 'PIN incorreto' });
    }
  });

  // POST /public/tasks/:token/approve - Approve delivery
  fastify.post('/public/tasks/:token/approve', async (request, reply) => {
    const { token } = request.params as { token: string };
    const clientIp = request.ip || (request.headers['x-forwarded-for'] as string) || 'unknown';

    const parsed = pinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'PIN inválido' });
    }

    try {
      const result = await ApprovalService.approve(token, parsed.data.pin, clientIp);
      return { data: result, message: 'Entrega aprovada com sucesso!' };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || 'Erro ao aprovar entrega' });
    }
  });

  // POST /public/tasks/:token/request-changes - Request adjustments
  fastify.post('/public/tasks/:token/request-changes', async (request, reply) => {
    const { token } = request.params as { token: string };
    const clientIp = request.ip || (request.headers['x-forwarded-for'] as string) || 'unknown';

    const parsed = requestChangesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    }

    try {
      const result = await ApprovalService.requestChanges(token, parsed.data.pin, parsed.data.feedback, clientIp);
      return { data: result, message: 'Solicitação de ajustes enviada à equipe com sucesso!' };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || 'Erro ao solicitar ajustes' });
    }
  });
}
