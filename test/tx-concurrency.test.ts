import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withTransaction, withProjectLock, withColumnsLock, withWorkspaceLock } from '../src/db/tx.js';
import prisma from '../src/db/prisma.js';

describe('E3.5-a / T11 - Utilitário Transacional e Concorrência (tx.ts)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('deve executar uma ação transacional com sucesso e retornar o resultado', async () => {
    const spyTransaction = vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      const mockTx = {
        task: { findUnique: vi.fn().mockResolvedValue({ id: 'task-1' }) },
      };
      return await cb(mockTx);
    });

    const result = await withTransaction(async (tx: any) => {
      return await tx.task.findUnique();
    });

    expect(result).toEqual({ id: 'task-1' });
    expect(spyTransaction).toHaveBeenCalledTimes(1);
  });

  it('deve retentar automaticamente em caso de serialization_failure (40001) e suceder na 2ª tentativa', async () => {
    let attempts = 0;
    const spyTransaction = vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      attempts++;
      if (attempts === 1) {
        const error: any = new Error('could not serialize access due to concurrent update');
        error.code = '40001';
        throw error;
      }
      return await cb({ success: true });
    });

    const result = await withTransaction(
      async () => {
        return { recovered: true };
      },
      { maxRetries: 3, initialBackoffMs: 5 }
    );

    expect(attempts).toBe(2);
    expect(result).toEqual({ recovered: true });
    expect(spyTransaction).toHaveBeenCalledTimes(2);
  });

  it('deve retentar automaticamente em caso de deadlock_detected (40P01) e suceder', async () => {
    let attempts = 0;
    const spyTransaction = vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      attempts++;
      if (attempts === 1) {
        const error: any = new Error('deadlock detected');
        error.code = '40P01';
        throw error;
      }
      return await cb({ success: true });
    });

    const result = await withTransaction(
      async () => {
        return { deadlockResolved: true };
      },
      { maxRetries: 3, initialBackoffMs: 5 }
    );

    expect(attempts).toBe(2);
    expect(result).toEqual({ deadlockResolved: true });
  });

  it('NÃO deve retentar em erro não transitório (ex: ValidationError) e lançar imediatamente', async () => {
    let attempts = 0;
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      attempts++;
      throw new Error('Validação falhou: campo obrigatório');
    });

    await expect(
      withTransaction(async () => {}, { maxRetries: 3, initialBackoffMs: 5 })
    ).rejects.toThrow('Validação falhou');

    expect(attempts).toBe(1); // Executou apenas 1 vez, sem retentativas indevidas
  });

  it('deve lançar erro quando o número máximo de retentativas for esgotado', async () => {
    let attempts = 0;
    vi.spyOn(prisma, '$transaction').mockImplementation(async () => {
      attempts++;
      const error: any = new Error('deadlock detected');
      error.code = '40P01';
      throw error;
    });

    await expect(
      withTransaction(async () => {}, { maxRetries: 3, initialBackoffMs: 5 })
    ).rejects.toThrow('deadlock detected');

    expect(attempts).toBe(3);
  });

  it('withProjectLock deve executar SELECT ... FOR UPDATE sobre a linha do projeto', async () => {
    const rawExecCalls: string[] = [];
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      const mockTx = {
        $executeRawUnsafe: vi.fn().mockImplementation(async (sql: string, ...args: any[]) => {
          rawExecCalls.push(`${sql} [${args.join(', ')}]`);
        }),
      };
      return await cb(mockTx);
    });

    await withProjectLock('proj-123', async (tx) => {
      return 'ok';
    });

    expect(rawExecCalls.length).toBe(1);
    expect(rawExecCalls[0]).toContain('SELECT 1 FROM "projects" WHERE "id" = $1 FOR UPDATE [proj-123]');
  });

  it('withColumnsLock deve ordenar os IDs de coluna de forma lexicográfica ascendente antes de bloquear', async () => {
    const lockedColumnIds: string[] = [];
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      const mockTx = {
        $executeRawUnsafe: vi.fn().mockImplementation(async (sql: string, id: string) => {
          lockedColumnIds.push(id);
        }),
      };
      return await cb(mockTx);
    });

    // Passa IDs desordenados e com duplicatas: ['col-z', 'col-a', 'col-m', 'col-a']
    await withColumnsLock(['col-z', 'col-a', 'col-m', 'col-a'], async (tx) => {
      return 'ok';
    });

    // Deve ter bloqueado em ordem determinística ['col-a', 'col-m', 'col-z']
    expect(lockedColumnIds).toEqual(['col-a', 'col-m', 'col-z']);
  });

  it('withWorkspaceLock deve executar SELECT ... FOR UPDATE sobre a linha do workspace', async () => {
    const rawExecCalls: string[] = [];
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      const mockTx = {
        $executeRawUnsafe: vi.fn().mockImplementation(async (sql: string, ...args: any[]) => {
          rawExecCalls.push(`${sql} [${args.join(', ')}]`);
        }),
      };
      return await cb(mockTx);
    });

    await withWorkspaceLock('ws-999', async (tx) => {
      return 'ok';
    });

    expect(rawExecCalls.length).toBe(1);
    expect(rawExecCalls[0]).toContain('SELECT 1 FROM "workspaces" WHERE "id" = $1 FOR UPDATE [ws-999]');
  });
});
