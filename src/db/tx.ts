import { Prisma } from '@prisma/client';
import prisma from './prisma.js';

export interface TxOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  timeout?: number;
}

/**
 * Utilitário transacional com retentativas automáticas em caso de deadlock ou erro de serialização (E3.5-a / E3.4-c).
 * Nenhuma chamada externa de rede ou IO não idempotente deve ser colocada dentro da ação.
 */
export async function withTransaction<T>(
  action: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TxOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialBackoffMs = options.initialBackoffMs ?? 30;

  let attempt = 0;
  while (true) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          return await action(tx);
        },
        {
          isolationLevel: options.isolationLevel,
          timeout: options.timeout ?? 10000,
        }
      );
    } catch (err: any) {
      attempt++;

      // Códigos de erro transitórios do PostgreSQL:
      // 40001: serialization_failure
      // 40P01: deadlock_detected
      const isRetryable =
        err?.code === '40001' ||
        err?.code === '40P01' ||
        err?.message?.includes('deadlock detected') ||
        err?.message?.includes('could not serialize access') ||
        err?.message?.includes('Transaction failed due to a write conflict') ||
        err?.message?.includes('deadlock_detected') ||
        err?.message?.includes('serialization_failure');

      if (isRetryable && attempt < maxRetries) {
        const jitter = Math.random() * initialBackoffMs;
        const delay = initialBackoffMs * Math.pow(2, attempt - 1) + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw err;
    }
  }
}

/**
 * Executa uma ação transacional com bloqueio pessimista a nível de projeto (FOR UPDATE).
 * Serializa de forma determinística mutações no grafo de dependências e numeração.
 */
export async function withProjectLock<T>(
  projectId: string,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TxOptions = {}
): Promise<T> {
  return withTransaction(async (tx) => {
    // Adquire bloqueio exclusivo na linha do projeto no PostgreSQL
    if (typeof (tx as any).$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe(
        'SELECT 1 FROM "projects" WHERE "id" = $1 FOR UPDATE',
        projectId
      );
    }
    return await action(tx);
  }, options);
}

/**
 * Executa uma ação transacional com bloqueio determinístico ordenado de colunas (FOR UPDATE) (E3.5-b / T11).
 * Ordena os IDs de forma lexicográfica ascendente antes de bloquear, eliminando deadlocks entre colunas.
 */
export async function withColumnsLock<T>(
  columnIds: string[],
  action: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TxOptions = {}
): Promise<T> {
  const sortedIds = Array.from(new Set(columnIds)).sort();
  return withTransaction(async (tx) => {
    if (typeof (tx as any).$executeRawUnsafe === 'function') {
      for (const colId of sortedIds) {
        await tx.$executeRawUnsafe(
          'SELECT 1 FROM "columns" WHERE "id" = $1 FOR UPDATE',
          colId
        );
      }
    }
    return await action(tx);
  }, options);
}

/**
 * Executa uma ação transacional com bloqueio pessimista a nível de workspace (FOR UPDATE) (E3.5-f).
 * Serializa mutações críticas de membership e proteção do último administrador.
 */
export async function withWorkspaceLock<T>(
  workspaceId: string,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TxOptions = {}
): Promise<T> {
  return withTransaction(async (tx) => {
    if (typeof (tx as any).$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe(
        'SELECT 1 FROM "workspaces" WHERE "id" = $1 FOR UPDATE',
        workspaceId
      );
    }
    return await action(tx);
  }, options);
}
