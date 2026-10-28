import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthUser, Actor } from '../types/index.js';
import { verifyJwtToken } from '../auth/jwt.js';
import { AuthClient, AuthServiceUnavailableError } from '../auth/auth-client.js';
import { UserProjectionService } from '../auth/projection.js';
import { IntegrationService } from '../services/integration.service.js';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Token de autenticação não fornecido ou cabeçalho inválido.',
      requestId: request.id,
    });
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Token Bearer ausente ou vazio.',
      requestId: request.id,
    });
  }

  // Autenticação de ServicePrincipal por chave `sp_...` (E1.7-b / E4.3-b)
  if (token.startsWith('sp_')) {
    const authResult = await IntegrationService.authenticateKey(token);
    if (!authResult) {
      return reply.status(401).send({
        code: 'INVALID_CREDENTIALS',
        message: 'Credencial de serviço inválida, revogada ou expirada.',
        requestId: request.id,
      });
    }

    const { principal, grants } = authResult;
    const allowedWorkspaces = grants.map((g) => g.workspaceId);
    const allowedTools = Array.from(new Set(grants.flatMap((g) => g.tools || [])));
    const canShare = grants.some((g) => g.canShare);

    const crmInstanceHeader = request.headers['x-crm-instance-id'];
    const crmContactHeader = request.headers['x-crm-contact-id'];
    const crmConversationHeader = request.headers['x-crm-conversation-id'];

    const crmInstanceId = typeof crmInstanceHeader === 'string' ? crmInstanceHeader.trim() : undefined;
    const crmContactId = typeof crmContactHeader === 'string' ? crmContactHeader.trim() : undefined;
    const crmConversationId = typeof crmConversationHeader === 'string' ? crmConversationHeader.trim() : undefined;

    const initiatedByHeader = request.headers['x-initiated-by-user-id'];
    const initiatedByUserId = typeof initiatedByHeader === 'string' ? initiatedByHeader.trim() : undefined;

    const effectiveMode = (grants[0]?.mode as any) || 'autonomous';

    request.actor = {
      type: 'service',
      id: principal.id,
      name: principal.name,
      mode: effectiveMode,
      grants: grants.map((g) => g.id),
      allowedWorkspaces,
      allowedTools,
      canShare,
      initiatedByUserId,
      ...(crmInstanceId ? { crmContext: { crmInstanceId, crmContactId, crmConversationId } } : {}),
    };

    return;
  }

  // 1. Validação local da assinatura JWT e claims estruturais com jose (E1.3-d / T01)
  const localVerification = await verifyJwtToken(token);
  if (!localVerification.valid || !localVerification.user) {
    return reply.status(401).send({
      code: 'INVALID_TOKEN',
      message: localVerification.error || 'Token inválido ou expirado.',
      requestId: request.id,
    });
  }

  // 2. Consulta de revogação e sessão ativa com o Auth (E1.3-e / T02)
  const isSensitive = Boolean((request.routeOptions.config as any)?.isSensitive);
  try {
    const liveValidation = await AuthClient.validateToken(token, isSensitive);
    if (!liveValidation.valid || !liveValidation.user) {
      return reply.status(401).send({
        code: 'TOKEN_REVOKED',
        message: liveValidation.error || 'Token revogado ou inativo.',
        requestId: request.id,
      });
    }

    // Associa o usuário canônico verificado à requisição
    request.user = liveValidation.user;
    request.actor = {
      type: 'user',
      id: liveValidation.user.id,
      name: liveValidation.user.name,
      email: liveValidation.user.email,
    };

    // Sincroniza a projeção de usuários (E1.6-e)
    UserProjectionService.syncUser(liveValidation.user).catch(() => {});
  } catch (err) {
    if (err instanceof AuthServiceUnavailableError) {
      return reply.status(503).send({
        code: 'AUTH_UNAVAILABLE',
        message: 'Serviço de autenticação temporariamente indisponível.',
        requestId: request.id,
      });
    }
    return reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Falha na validação de autenticação.',
      requestId: request.id,
    });
  }
}
