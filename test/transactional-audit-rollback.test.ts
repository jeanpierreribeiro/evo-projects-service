import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { TaskService } from '../src/services/task.service.js';
import { ActivityService } from '../src/services/activity.service.js';
import { UserActor } from '../src/types/auth.js';

describe('E3.5-c / T11 - Auditoria Transacional e Rollback Automático', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deve REVERTER a criação de tarefa caso a gravação de auditoria falhe (T11 / E3.5-c)', async () => {
    const uniqueTitle = `Tarefa Teste Falha Auditoria ${Date.now()}`;

    // Força falha no ActivityService.log
    vi.spyOn(ActivityService, 'log').mockRejectedValueOnce(
      new Error('Simulated database audit log failure (disk full / connection drop)')
    );

    // Tentativa de criação deve lançar erro
    await expect(
      TaskService.createTask(
        projectId,
        {
          title: uniqueTitle,
          columnId,
        },
        actor
      )
    ).rejects.toThrow('Simulated database audit log failure');

    // Verifica que a tarefa NÃO foi persistida no banco (rollback atômico)
    const taskInDb = await prisma.task.findFirst({
      where: {
        projectId,
        title: uniqueTitle,
      },
    });

    expect(taskInDb).toBeNull();
  });

  it('deve REVERTER a atualização de tarefa caso a auditoria falhe', async () => {
    // 1. Cria tarefa com sucesso
    const initialTitle = `Tarefa Base ${Date.now()}`;
    const task = await TaskService.createTask(
      projectId,
      {
        title: initialTitle,
        columnId,
      },
      actor
    );

    // 2. Tenta atualizar injetando falha de auditoria
    vi.spyOn(ActivityService, 'log').mockRejectedValueOnce(
      new Error('Falha simulada na auditoria de update')
    );

    await expect(
      TaskService.updateTask(
        task.id,
        {
          title: 'Novo Título Que Não Deve Salvar',
        },
        actor
      )
    ).rejects.toThrow('Falha simulada na auditoria de update');

    // 3. Verifica que o título no banco permanece o inicial e a versão não foi incrementada indevidamente
    const checkDb = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
    });

    expect(checkDb.title).toBe(initialTitle);
    expect(checkDb.version).toBe(task.version);

    // Cleanup
    await TaskService.deleteTask(task.id, actor);
  });
});
