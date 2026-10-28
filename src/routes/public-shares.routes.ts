import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../db/prisma.js';
import { config } from '../config/env.js';
import {
  hashToken,
  verifyPin,
  generateSessionToken,
  hashSessionToken,
} from '../share/crypto.js';
import { buildPublicCard } from '../share/public-card.js';
import { RateLimiterService } from '../share/attempts.js';
import { ShareService } from '../services/share.service.js';
import { AttachmentService } from '../services/attachment.service.js';
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from '../errors/app-error.js';

const unlockSchema = z.object({
  pin: z.string().regex(/^\d{6}$/, 'O PIN deve conter exatamente 6 dígitos numéricos'),
});

export async function publicShareRoutes(fastify: FastifyInstance) {
  // Hook para verificar a feature flag PROJECTS_SHARING_ENABLED
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    if (!config.projectsSharingEnabled) {
      throw new ForbiddenError(
        'O recurso de compartilhamento público está desabilitado nesta instância (PROJECTS_SHARING_ENABLED=false).',
        'FEATURE_DISABLED'
      );
    }
  });

  // POST /public/shares/:token/unlock - Valida PIN e emite sessão pública
  fastify.post(
    '/public/shares/:token/unlock',
    {
      config: {
        isPublic: true,
        policy: {
          action: 'unlock',
          resource: 'public_shares',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { token: string }; Body: unknown }>,
      reply: FastifyReply
    ) => {
      const { token } = request.params;
      const ip = request.ip || '127.0.0.1';
      const tokenHash = hashToken(token);

      // 1. Verificação de Rate Limit ANTES da busca de banco e computação do hash (E2.3-a / T08)
      const rateLimit = await RateLimiterService.checkRateLimit(tokenHash, ip);
      if (!rateLimit.allowed) {
        return reply
          .header('Retry-After', String(rateLimit.retryAfterSeconds || 900))
          .status(429)
          .send({
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Muitas tentativas de PIN incorretas. Tente novamente mais tarde.',
            retryAfterSeconds: rateLimit.retryAfterSeconds || 900,
          });
      }

      // Validação do formato do PIN
      const parsed = unlockSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Formato de PIN inválido.', parsed.error.format());
      }
      const { pin } = parsed.data;

      // 2. Busca do compartilhamento por hash do token
      const now = new Date();
      const share = await prisma.taskShare.findUnique({
        where: { tokenHash },
        include: { task: true },
      });

      // Uniforme 404 para link inexistente, expirado ou revogado (evita enumeração)
      if (!share || share.revokedAt || share.expiresAt <= now) {
        throw new NotFoundError('Compartilhamento indisponível.', 'SHARE_UNAVAILABLE');
      }

      // 3. Validação de elegibilidade do criador (E2.4-a)
      await ShareService.assertEligible(share);

      // 4. Verificação do PIN contra o hash armazenado
      const pinMatches = await verifyPin(pin, share.pinHash);
      if (!pinMatches) {
        const failure = await RateLimiterService.recordFailedAttempt(
          tokenHash,
          ip,
          share.workspaceId,
          share.taskId
        );

        if (failure.remainingAttempts === 0) {
          return reply
            .header('Retry-After', String(failure.retryAfterSeconds || 900))
            .status(429)
            .send({
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'Limite de tentativas excedido. O link foi temporariamente bloqueado por 15 minutos.',
              retryAfterSeconds: failure.retryAfterSeconds || 900,
            });
        }

        return reply.status(401).send({
          code: 'PIN_INVALID',
          message: 'PIN de acesso incorreto.',
          remainingAttempts: failure.remainingAttempts,
        });
      }

      // 5. Sucesso: Reseta contador de tentativas para este IP/share
      await RateLimiterService.resetAttempts(tokenHash, ip);

      // 6. Emissão de sessão pública opaca
      const sessionToken = generateSessionToken();
      const sessionTokenHash = hashSessionToken(sessionToken);

      const maxSessionMs = config.shareSessionTtlMinutes * 60 * 1000;
      const remainingShareMs = share.expiresAt.getTime() - now.getTime();
      const sessionDurationMs = Math.min(maxSessionMs, remainingShareMs);
      const sessionExpiresAt = new Date(now.getTime() + sessionDurationMs);

      await prisma.taskShareSession.create({
        data: {
          shareId: share.id,
          sessionTokenHash,
          ip,
          userAgent: request.headers['user-agent'] || null,
          expiresAt: sessionExpiresAt,
        },
      });

      // Configuração segura do cookie de sessão (E2.3-b)
      reply.setCookie('task_share_session', sessionToken, {
        path: `/api/v1/projects/public/shares/${token}`,
        httpOnly: true,
        sameSite: 'strict',
        secure: config.nodeEnv === 'production',
        expires: sessionExpiresAt,
      });

      return reply.send({
        success: true,
        sessionToken,
        expiresAt: sessionExpiresAt.toISOString(),
        taskId: share.taskId,
      });
    }
  );

  // GET /public/shares/:token/card - Leitura do card compartilhado após autenticação por PIN
  fastify.get(
    '/public/shares/:token/card',
    {
      config: {
        isPublic: true,
        policy: {
          action: 'read_card',
          resource: 'public_shares',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { token: string } }>,
      reply: FastifyReply
    ) => {
      const { token } = request.params;
      const tokenHash = hashToken(token);

      // Sessão obtida pelo cookie ou cabeçalho Authorization
      const sessionToken =
        (request.cookies as any)?.task_share_session ||
        (request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.substring(7).trim()
          : null);

      if (!sessionToken) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Sessão de compartilhamento não encontrada ou PIN não informado.',
        });
      }

      const sessionTokenHash = hashSessionToken(sessionToken);
      const now = new Date();

      // Busca e valida a sessão
      const session = await prisma.taskShareSession.findUnique({
        where: { sessionTokenHash },
        include: {
          share: {
            include: {
              task: {
                include: {
                  column: true,
                  subtasks: { orderBy: { position: 'asc' } },
                  resources: true,
                  attachments: true,
                  fieldValues: { include: { field: true } },
                },
              },
              resources: true,
              attachments: true,
              customFields: true,
            },
          },
        },
      });

      // Verifica validade da sessão e correspondência do share
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= now ||
        session.share.tokenHash !== tokenHash ||
        session.share.revokedAt ||
        session.share.expiresAt <= now
      ) {
        return reply.status(401).send({
          code: 'SESSION_EXPIRED',
          message: 'A sessão expirou ou o compartilhamento foi revogado.',
        });
      }

      // Validação de elegibilidade do criador a cada leitura (E2.3-c / E2.4-a)
      await ShareService.assertEligible(session.share);

      const share = session.share;
      const selectedResourceIds = share.resources.map((r) => r.resourceId);
      const selectedAttachmentIds = share.attachments.map((a) => a.attachmentId);
      const selectedCustomFieldIds = share.customFields.map((c) => c.customFieldId);

      // Constrói DTO público sanitizado
      const card = buildPublicCard(share.task, {
        showDescription: share.showDescription,
        showSubtasks: share.showSubtasks,
        showResources: share.showResources,
        showAttachments: share.showAttachments,
        showCustomFields: share.showCustomFields,
        selectedResourceIds,
        selectedAttachmentIds,
        selectedCustomFieldIds,
        shareToken: token,
        publicContentUpdatedAt: share.publicContentUpdatedAt || share.task.updatedAt,
      });

      // Cabeçalhos de segurança obrigatórios para o portal (E2.3-c)
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Robots-Tag', 'noindex');

      return reply.send({ data: card });
    }
  );

  // GET /public/shares/:token/attachments/:attachmentId - Download público com PIN e sessão (E3.7-c / T10)
  fastify.get(
    '/public/shares/:token/attachments/:attachmentId',
    {
      config: {
        isPublic: true,
        policy: {
          action: 'read_attachment',
          resource: 'public_shares',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { token: string; attachmentId: string } }>,
      reply: FastifyReply
    ) => {
      const { token, attachmentId } = request.params;
      const tokenHash = hashToken(token);

      // Validação de sessão pública ativa
      const sessionToken =
        (request.cookies as any)?.task_share_session ||
        (request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.substring(7).trim()
          : null);

      if (!sessionToken) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED_SHARE_SESSION',
          message: 'Sessão pública não informada ou expirada.',
        });
      }

      const sessionTokenHash = hashSessionToken(sessionToken);
      const session = await prisma.taskShareSession.findUnique({
        where: { sessionTokenHash },
        include: { share: true },
      });

      const now = new Date();
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= now ||
        session.share.tokenHash !== tokenHash ||
        session.share.revokedAt ||
        session.share.expiresAt <= now
      ) {
        return reply.status(401).send({
          code: 'SESSION_EXPIRED',
          message: 'A sessão expirou ou o compartilhamento foi revogado.',
        });
      }

      await ShareService.assertEligible(session.share);

      const { attachment, fileResult } =
        await AttachmentService.getAttachmentForPublicDownload(token, attachmentId);

      const safeInlineTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      const disposition = safeInlineTypes.includes(attachment.mimeType)
        ? 'inline'
        : `attachment; filename="${attachment.filename}"`;

      reply.header('Content-Type', attachment.mimeType);
      reply.header('Content-Disposition', disposition);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'");
      reply.header('Cache-Control', 'no-store, private');

      return reply.send(fileResult.stream);
    }
  );

  // POST /public/shares/:token/logout - Encerra a sessão pública
  fastify.post(
    '/public/shares/:token/logout',
    {
      config: {
        isPublic: true,
        policy: {
          action: 'logout',
          resource: 'public_shares',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { token: string } }>,
      reply: FastifyReply
    ) => {
      const { token } = request.params;
      const sessionToken =
        (request.cookies as any)?.task_share_session ||
        (request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.substring(7).trim()
          : null);

      if (sessionToken) {
        const sessionTokenHash = hashSessionToken(sessionToken);
        await prisma.taskShareSession.updateMany({
          where: { sessionTokenHash, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      reply.clearCookie('task_share_session', {
        path: `/api/v1/projects/public/shares/${token}`,
      });

      return reply.send({ success: true, message: 'Sessão encerrada com sucesso.' });
    }
  );
}
