import crypto from 'node:crypto';
import prisma from '../db/prisma.js';
import { ConflictError } from '../errors/app-error.js';
import { withTransaction } from '../db/tx.js';

/**
 * Serviço de Idempotência Centralizado (E2.2-b / E3.5-d / T20).
 * Garante que requisições repetidas e comandos de retentativa (API, agentes, MCP)
 * não causem mutações duplicadas.
 * Retenção padrão: 72 horas documentada.
 */
export class IdempotencyService {
  public static readonly RETENTION_HOURS = 72;

  /**
   * Constrói a chave canônica com escopo por ator, workspace e operação (E3.5-d).
   */
  static buildScopeKey(actorId: string, workspaceId: string, operation: string, clientKey?: string): string {
    const key = clientKey ? clientKey.trim() : 'default';
    return `${actorId}:${workspaceId}:${operation}:${key}`;
  }

  /**
   * Executa uma operação com garantia de idempotência sob concorrência.
   * Se a chave já existir com o mesmo hash de requisição:
   *   - Retorna o resultado salvo (fromCache: true) sem reexecutar.
   * Se a chave já existir com hash diferente:
   *   - Lança 409 Conflict (IDEMPOTENCY_PAYLOAD_MISMATCH).
   * Retentativas concorrentes são serializadas por chave usando trava transacional.
   */
  static async runIdempotent<T>(
    scopeKey: string,
    requestBody: any,
    operation: () => Promise<{ statusCode: number; result: T }>
  ): Promise<{ statusCode: number; result: T; fromCache: boolean }> {
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(requestBody || {}))
      .digest('hex');

    // 1. Verificação rápida prévia fora de transação
    const quickCheck = await prisma.idempotencyRecord.findUnique({
      where: { scopeKey },
    });

    if (quickCheck) {
      if (quickCheck.requestHash !== requestHash) {
        throw new ConflictError(
          'A mesma Idempotency-Key foi enviada anteriormente com um corpo de requisição diferente.',
          'IDEMPOTENCY_PAYLOAD_MISMATCH'
        );
      }

      if (quickCheck.expiresAt > new Date()) {
        return {
          statusCode: quickCheck.statusCode,
          result: quickCheck.responseJson as T,
          fromCache: true,
        };
      }

      // Registro expirado
      await prisma.idempotencyRecord.delete({ where: { scopeKey } }).catch(() => {});
    }

    // 2. Executa a operação protegida por serialização transacional (E3.5-d / T20)
    return await withTransaction(async (tx) => {
      // Bloqueio de chave contra concorrência
      if (typeof (tx as any).$executeRawUnsafe === 'function') {
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          scopeKey
        );
      }

      // Re-verifica se outra requisição concorrente acabou de salvar o resultado
      const existingInTx = await tx.idempotencyRecord.findUnique({
        where: { scopeKey },
      });

      if (existingInTx) {
        if (existingInTx.requestHash !== requestHash) {
          throw new ConflictError(
            'A mesma Idempotency-Key foi enviada anteriormente com um corpo de requisição diferente.',
            'IDEMPOTENCY_PAYLOAD_MISMATCH'
          );
        }

        if (existingInTx.expiresAt > new Date()) {
          return {
            statusCode: existingInTx.statusCode,
            result: existingInTx.responseJson as T,
            fromCache: true,
          };
        }

        await tx.idempotencyRecord.delete({ where: { scopeKey } }).catch(() => {});
      }

      // 3. Executa a operação real
      const { statusCode, result } = await operation();

      // 4. Salva o resultado no banco com retenção de 72h
      const expiresAt = new Date(Date.now() + IdempotencyService.RETENTION_HOURS * 60 * 60 * 1000);

      await tx.idempotencyRecord.upsert({
        where: { scopeKey },
        update: {
          requestHash,
          statusCode,
          responseJson: result as any,
          expiresAt,
        },
        create: {
          scopeKey,
          requestHash,
          statusCode,
          responseJson: result as any,
          expiresAt,
        },
      });

      return { statusCode, result, fromCache: false };
    });
  }
}
