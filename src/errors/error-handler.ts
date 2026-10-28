import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './app-error.js';

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const requestId = request.id;

  // Erros de aplicação conhecidos e tipados
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    });
  }

  // Erros de validação estrutural ou sintaxe do Fastify/Zod/JSON
  if ((error as any).validation || (error as any).statusCode === 400 || error.name === 'SyntaxError') {
    return reply.status(400).send({
      code: 'VALIDATION_ERROR',
      message: error.message || 'Dados de entrada inválidos.',
      requestId,
      details: (error as any).validation,
    });
  }

  // Erro 410 específico
  if (error.message === 'LEGACY_FEATURE_REMOVED') {
    return reply.status(410).send({
      code: 'LEGACY_FEATURE_REMOVED',
      message: 'Esta funcionalidade legada de aprovação foi descontinuada.',
      requestId,
    });
  }

  // Erro interno não tratado: NÃO expor err.message de banco, stack trace ou caminhos de arquivo (X3 / E1.5-c)
  console.error('[UNHANDLED_ERROR]', error);
  request.log?.error?.(error);

  return reply.status(500).send({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Ocorreu um erro interno ao processar a solicitação.',
    requestId,
  });
}
