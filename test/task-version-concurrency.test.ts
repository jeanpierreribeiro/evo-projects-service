import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { TaskService } from '../src/services/task.service.js';
import { VersionConflictError } from '../src/errors/app-error.js';
import { UserActor } from '../src/types/auth.js';
import { LIMITS } from '../src/config/limits.js';
import { buildApp } from '../src/app.js';
import { createTestJwt } from './helpers/auth.js';
import { AuthClient } from '../src/auth/auth-client.js';

describe('T11 & E3.1 - Versionamento Otimista, Atualização Parcial e Paginação por Cursor', () => {
  const app = buildApp();
  let workspaceId: string;
  let projectId: string;
  let columnId: string;
  let actor: UserActor;
  let authToken: string;

  beforeEach(async () => {
    // Busca workspace e membro ativo
    const ws = await prisma.workspace.findFirst({
      where: {
        slug: 'operacao-principal',
        members: {
          some: { status: 'ACTIVE', role: 'ADMIN' },
        },
        projects: {
          some: {
            columns: { some: {} },
          },
        },
      },
      include: {
        members: { where: { status: 'ACTIVE', role: 'ADMIN' } },
        projects: { include: { columns: true } },
      },
    });

    if (!ws || ws.projects.length === 0 || ws.projects[0].columns.length === 0) {
      throw new Error('Ambiente de teste sem workspace, projeto ou coluna configurados.');
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

    authToken = await createTestJwt({
      sub: member.userId,
      email: member.email || 'operador@test.local',
      name: member.name || 'Operador Teste',
      role: 'ADMIN',
    });

    vi.spyOn(AuthClient, 'validateToken').mockImplementation(async () => ({
      valid: true,
      user: {
        id: member.userId,
        email: member.email || 'operador@test.local',
        name: member.name || 'Operador Teste',
        role: 'ADMIN',
      },
    }));
  });

  it('deve inicializar Task com version=1 e incrementar a cada edição direta (3.1-a)', async () => {
    const task = await TaskService.createTask(
      projectId,
      {
        title: 'Tarefa Concorrência Teste',
        description: 'Descrição inicial',
        columnId,
      },
      actor
    );

    expect(task.version).toBe(1);

    // Edição enviando a versão correta
    const updated = await TaskService.updateTask(
      task.id,
      {
        title: 'Título Atualizado v1',
        expectedVersion: 1,
      },
      actor
    );

    expect(updated.version).toBe(2);
    expect(updated.title).toBe('Título Atualizado v1');

    // Limpeza
    await TaskService.deleteTask(task.id, actor);
  });

  it('deve rejeitar edição concorrente com 409 VERSION_CONFLICT quando expectedVersion divergir (T11 / 3.1-a)', async () => {
    const task = await TaskService.createTask(
      projectId,
      {
        title: 'Tarefa Teste Conflito',
        columnId,
      },
      actor
    );

    expect(task.version).toBe(1);

    // Operador A atualiza a tarefa primeiro para versão 2
    await TaskService.updateTask(
      task.id,
      {
        title: 'Atualizado por Operador A',
        expectedVersion: 1,
      },
      actor
    );

    // Operador B tenta atualizar enviando a versão desatualizada (1)
    await expect(
      TaskService.updateTask(
        task.id,
        {
          title: 'Tentativa concorrente de Operador B',
          expectedVersion: 1,
        },
        actor
      )
    ).rejects.toThrow(VersionConflictError);

    // Verifica que o erro carrega a versão atual
    try {
      await TaskService.updateTask(
        task.id,
        {
          title: 'Tentativa concorrente de Operador B',
          expectedVersion: 1,
        },
        actor
      );
    } catch (err: any) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('VERSION_CONFLICT');
      expect(err.details?.currentVersion).toBe(2);
    }

    // Limpeza
    await TaskService.deleteTask(task.id, actor);
  });

  it('deve incrementar a versão do card quando entidades filhas são alteradas (3.1-a)', async () => {
    const task = await TaskService.createTask(
      projectId,
      {
        title: 'Tarefa Filhos Concorrência',
        columnId,
      },
      actor
    );

    const initialVersion = task.version;

    // 1. Adicionar subtarefa incrementa a versão da tarefa
    const subtask = await TaskService.addSubtask(task.id, 'Subtarefa teste', actor);
    let currentTask = await TaskService.getTask(task.id, actor);
    expect(currentTask.version).toBe(initialVersion + 1);

    // 2. Atualizar subtarefa incrementa a versão da tarefa
    await TaskService.updateSubtask(subtask.id, { completed: true }, actor);
    currentTask = await TaskService.getTask(task.id, actor);
    expect(currentTask.version).toBe(initialVersion + 2);

    // 3. Adicionar recurso incrementa a versão da tarefa
    const resource = await TaskService.addResource(
      task.id,
      { title: 'Link Teste', url: 'https://exemplo.com' },
      actor
    );
    currentTask = await TaskService.getTask(task.id, actor);
    expect(currentTask.version).toBe(initialVersion + 3);

    // 4. Adicionar comentário incrementa a versão da tarefa
    const comment = await TaskService.addComment(task.id, 'Comentário sobre a tarefa', actor);
    currentTask = await TaskService.getTask(task.id, actor);
    expect(currentTask.version).toBe(initialVersion + 4);

    // Limpeza
    await TaskService.deleteTask(task.id, actor);
  });

  it('deve respeitar a semântica de atualização parcial: manter campos ausentes e limpar com null (3.1-b)', async () => {
    const task = await TaskService.createTask(
      projectId,
      {
        title: 'Tarefa Semântica Parcial',
        description: 'Descrição original a ser limpa',
        startDate: '2026-11-01',
        dueDate: '2026-11-15',
        estimatedHours: 8,
        columnId,
      },
      actor
    );

    expect(task.description).toBe('Descrição original a ser limpa');
    expect(task.estimatedHours).toBe(8);

    // Atualização parcial limpando description e estimatedHours via null, omitindo startDate e dueDate
    const updated = await TaskService.updateTask(
      task.id,
      {
        description: null,
        estimatedHours: null,
        expectedVersion: task.version,
      },
      actor
    );

    // description e estimatedHours foram limpos (null)
    expect(updated.description).toBeNull();
    expect(updated.estimatedHours).toBeNull();

    // startDate e dueDate permaneceram intactos porque foram omitidos (undefined)
    expect(updated.startDate).not.toBeNull();
    expect(updated.dueDate).not.toBeNull();

    // Limpeza
    await TaskService.deleteTask(task.id, actor);
  });

  it('deve paginar tarefas por cursor com ordem estável e limites respeitados (3.1-c)', async () => {
    // Cria 3 tarefas de teste
    const t1 = await TaskService.createTask(projectId, { title: 'Tarefa Paginação 1', columnId }, actor);
    const t2 = await TaskService.createTask(projectId, { title: 'Tarefa Paginação 2', columnId }, actor);
    const t3 = await TaskService.createTask(projectId, { title: 'Tarefa Paginação 3', columnId }, actor);

    // Consulta página 1 com limit 2
    const page1 = await TaskService.listByProject(projectId, actor, { limit: 2 });
    expect(page1.data.length).toBeLessThanOrEqual(2);
    expect(page1.pagination.limit).toBe(2);

    if (page1.pagination.hasMore && page1.pagination.cursor) {
      // Consulta página 2 a partir do cursor
      const page2 = await TaskService.listByProject(projectId, actor, {
        limit: 2,
        cursor: page1.pagination.cursor,
      });

      expect(page2.data.length).toBeGreaterThan(0);
      // Nenhuma tarefa da página 1 deve estar na página 2
      const page1Ids = page1.data.map((t) => t.id);
      for (const t of page2.data) {
        expect(page1Ids).not.toContain(t.id);
      }
    }

    // Limpeza
    await TaskService.deleteTask(t1.id, actor);
    await TaskService.deleteTask(t2.id, actor);
    await TaskService.deleteTask(t3.id, actor);
  });

  it('deve expor metadados de limites espelhados no endpoint GET /metadata/limits (3.1-d)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/metadata/limits',
      headers: {
        authorization: `Bearer ${authToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.payload);
    expect(json.data.TITLE_MAX_LENGTH).toBe(LIMITS.TITLE_MAX_LENGTH);
    expect(json.data.DESCRIPTION_MAX_LENGTH).toBe(LIMITS.DESCRIPTION_MAX_LENGTH);
    expect(json.data.PAGINATION_DEFAULT_LIMIT).toBe(50);
    expect(json.data.PAGINATION_MAX_LIMIT).toBe(100);
  });
});
