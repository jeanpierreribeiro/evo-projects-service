import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { IdempotencyService } from '../src/services/idempotency.service.js';
import { TaskService } from '../src/services/task.service.js';
import { ConflictError } from '../src/errors/app-error.js';
import { UserActor } from '../src/types/auth.js';

describe('E3.5-d / T20 - Idempotência Geral (IdempotencyService)', () => {
  let workspaceId: string;
  let projectId: string;
  let columnId: string;
  let actor: UserActor;

  beforeEach(async () => {
    const ws = await prisma.workspace.findFirst({
      where: {
        slug: 'operacao-principal',
        members: { some: { status: 'ACTIVE', role: 'ADMIN' } },
        projects: { some: { columns: { some: {} } } },
      },
      include: {
        members: { where: { status: 'ACTIVE', role: 'ADMIN' } },
        projects: { include: { columns: true } },
      },
    });

    if (!ws || ws.projects.length === 0 || ws.projects[0].columns.length === 0) {
      throw new Error('Ambiente de teste sem workspace/projeto.');
    }

    workspaceId = ws.id;
    projectId = ws.projects[0].id;
    columnId = ws.projects[0].columns[0].id;
    const member = ws.members[0];

    actor = {
      type: 'user',
      id: member.userId,
      role: 'ADMIN',
      tokenWorkspaceId: workspaceId,
    };
  });

  afterEach(async () => {
    // Limpa registros de idempotência de teste
    await prisma.idempotencyRecord.deleteMany({
      where: { scopeKey: { contains: 'test-idem' } },
    });
  });

  it('buildScopeKey deve construir a chave canônica estruturada por ator, workspace e operação', () => {
    const key = IdempotencyService.buildScopeKey('actor-1', 'ws-1', 'create_task', 'req-123');
    expect(key).toBe('actor-1:ws-1:create_task:req-123');

    const defaultKey = IdempotencyService.buildScopeKey('actor-1', 'ws-1', 'create_task');
    expect(defaultKey).toBe('actor-1:ws-1:create_task:default');
  });

  it('deve executar a operação pela primeira vez e armazenar o resultado', async () => {
    const scopeKey = `test-idem:${Date.now()}:op1`;
    const payload = { title: 'Tarefa Idempotente 1', count: 42 };

    let executedTimes = 0;
    const result1 = await IdempotencyService.runIdempotent(scopeKey, payload, async () => {
      executedTimes++;
      return { statusCode: 201, result: { id: 'task-test-1', title: payload.title } };
    });

    expect(executedTimes).toBe(1);
    expect(result1.fromCache).toBe(false);
    expect(result1.statusCode).toBe(201);
    expect(result1.result.id).toBe('task-test-1');

    // Segunda chamada com mesmo scopeKey e mesmo payload
    const result2 = await IdempotencyService.runIdempotent(scopeKey, payload, async () => {
      executedTimes++;
      return { statusCode: 201, result: { id: 'task-test-should-not-run' } };
    });

    expect(executedTimes).toBe(1); // Não executou novamente!
    expect(result2.fromCache).toBe(true);
    expect(result2.statusCode).toBe(201);
    expect(result2.result.id).toBe('task-test-1');
  });

  it('deve lançar 409 Conflict quando a mesma chave for enviada com corpo diferente (E3.5-d)', async () => {
    const scopeKey = `test-idem:${Date.now()}:op-mismatch`;
    const payloadOriginal = { title: 'Criar relatório financeiro' };
    const payloadDivergente = { title: 'Criar relatório financeiro com outros dados' };

    await IdempotencyService.runIdempotent(scopeKey, payloadOriginal, async () => {
      return { statusCode: 201, result: { status: 'created' } };
    });

    // Mesma chave com payload diferente
    await expect(
      IdempotencyService.runIdempotent(scopeKey, payloadDivergente, async () => {
        return { statusCode: 201, result: { status: 'should-fail' } };
      })
    ).rejects.toThrow(ConflictError);
  });

  it('deve serializar requisições concorrentes para a mesma chave sem duplicar a operação', async () => {
    const scopeKey = `test-idem:${Date.now()}:concurrent`;
    const payload = { action: 'concurrent_job', key: 'parallel' };

    let counter = 0;
    const parallelCalls = Array.from({ length: 5 }, () =>
      IdempotencyService.runIdempotent(scopeKey, payload, async () => {
        counter++;
        // Simula tempo de processamento
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { statusCode: 201, result: { counterValue: counter } };
      })
    );

    const results = await Promise.all(parallelCalls);

    // Exatamente uma execução real deve ter ocorrido
    expect(counter).toBe(1);

    // Todos os 5 callers recebem o mesmo resultado
    for (const res of results) {
      expect(res.statusCode).toBe(201);
      expect((res.result as any).counterValue).toBe(1);
    }

    // 4 callers vieram do cache/concorrência resolvida
    const fromCacheCount = results.filter((r) => r.fromCache).length;
    expect(fromCacheCount).toBe(4);
  });
});
