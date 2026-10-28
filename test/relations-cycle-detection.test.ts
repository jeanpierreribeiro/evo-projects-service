import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { TaskService } from '../src/services/task.service.js';
import { ProjectService } from '../src/services/project.service.js';
import { RelationType } from '@prisma/client';
import { ValidationError, ConflictError } from '../src/errors/app-error.js';
import { UserActor } from '../src/types/auth.js';

describe('T12 & E3.4 - Integridade Relacional, Responsável Ativo e Relações sem Ciclos', () => {
  let workspaceId: string;
  let projectId: string;
  let actor: UserActor;

  beforeEach(async () => {
    const ws = await prisma.workspace.findFirst({
      where: {
        slug: 'operacao-principal',
        members: {
          some: { status: 'ACTIVE', role: 'ADMIN' },
        },
      },
      include: {
        members: { where: { status: 'ACTIVE', role: 'ADMIN' } },
        projects: true,
      },
    });

    if (!ws || ws.members.length === 0) {
      throw new Error('Ambiente de teste sem workspace ativo.');
    }

    workspaceId = ws.id;
    const admin = ws.members[0];

    actor = {
      type: 'user',
      id: admin.userId,
      role: 'ADMIN',
      tokenWorkspaceId: workspaceId,
    };

    // Cria um projeto limpo para cada suite de teste
    const p = await ProjectService.createProject(
      workspaceId,
      {
        name: `Projeto Relacoes ${Date.now()}-${Math.random()}`,
        key: `R${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      },
      actor
    );
    projectId = p.id;
  });

  describe('3.4-b / I3: Responsável Ativo e Integridade de Assignee', () => {
    it('deve rejeitar responsável que não seja membro ativo do workspace', async () => {
      await expect(
        TaskService.createTask(
          projectId,
          {
            title: 'Tarefa Invalida',
            assigneeId: 'user-inexistente-12345',
          },
          actor
        )
      ).rejects.toThrow(ValidationError);
    });

    it('deve extrair assigneeName e assigneeAvatar do cadastro confiável e ignorar payloads forjados', async () => {
      const task = await TaskService.createTask(
        projectId,
        {
          title: 'Tarefa com Responsavel',
          assigneeId: actor.id,
          assigneeName: 'Nome Forjado pelo Hacker',
          assigneeAvatar: 'https://hacker.com/fake.png',
        },
        actor
      );

      // Deve ter resolvido para o nome real do membro ativo no workspace
      const member = await prisma.workspaceMember.findUniqueOrThrow({
        where: { workspaceId_userId: { workspaceId, userId: actor.id } },
      });

      expect(task.assigneeId).toBe(actor.id);
      expect(task.assigneeName).toBe(member.name);
      expect(task.assigneeName).not.toBe('Nome Forjado pelo Hacker');
    });

    it('deve limpar assigneeName e avatar ao enviar assigneeId: null no update', async () => {
      const task = await TaskService.createTask(
        projectId,
        {
          title: 'Tarefa com Responsavel Inicial',
          assigneeId: actor.id,
        },
        actor
      );
      expect(task.assigneeId).toBe(actor.id);

      const updated = await TaskService.updateTask(
        task.id,
        { assigneeId: null },
        actor
      );

      expect(updated.assigneeId).toBeNull();
      expect(updated.assigneeName).toBeNull();
      expect(updated.assigneeAvatar).toBeNull();
    });
  });

  describe('3.4-c / I2 / T12: Relações entre Tarefas e Detecção de Ciclos', () => {
    it('deve impedir autorreferência e tarefas de projetos distintos', async () => {
      const taskA = await TaskService.createTask(projectId, { title: 'Tarefa A' }, actor);

      // Autorreferência
      await expect(
        TaskService.addRelation(taskA.id, taskA.id, RelationType.BLOCKS, actor)
      ).rejects.toThrow(ValidationError);

      // Outro projeto
      const proj2 = await ProjectService.createProject(
        workspaceId,
        { name: 'Segundo Projeto' },
        actor
      );
      const taskOutro = await TaskService.createTask(proj2.id, { title: 'Tarefa B' }, actor);

      await expect(
        TaskService.addRelation(taskA.id, taskOutro.id, RelationType.BLOCKS, actor)
      ).rejects.toThrow(ValidationError);
    });

    it('deve normalizar BLOCKED_BY para BLOCKS e evitar duplicatas', async () => {
      const taskA = await TaskService.createTask(projectId, { title: 'Tarefa A' }, actor);
      const taskB = await TaskService.createTask(projectId, { title: 'Tarefa B' }, actor);

      // A BLOCKS B
      const rel1 = await TaskService.addRelation(taskA.id, taskB.id, RelationType.BLOCKS, actor);
      expect(rel1.taskId).toBe(taskA.id);
      expect(rel1.relatedTaskId).toBe(taskB.id);
      expect(rel1.type).toBe(RelationType.BLOCKS);

      // B BLOCKED_BY A equivale ao mesmo sentido (A BLOCKS B), logo deve ser recusado como duplicata
      await expect(
        TaskService.addRelation(taskB.id, taskA.id, RelationType.BLOCKED_BY, actor)
      ).rejects.toThrow(ConflictError);
    });

    it('deve normalizar pares de RELATES_TO para evitar duplicatas simétricas', async () => {
      const taskA = await TaskService.createTask(projectId, { title: 'Tarefa A' }, actor);
      const taskB = await TaskService.createTask(projectId, { title: 'Tarefa B' }, actor);

      // A RELATES_TO B
      await TaskService.addRelation(taskA.id, taskB.id, RelationType.RELATES_TO, actor);

      // B RELATES_TO A deve ser detectado como a mesma relação
      await expect(
        TaskService.addRelation(taskB.id, taskA.id, RelationType.RELATES_TO, actor)
      ).rejects.toThrow(ConflictError);
    });

    it('deve detectar ciclo direto: A bloqueia B e B bloqueia A (T12)', async () => {
      const taskA = await TaskService.createTask(projectId, { title: 'Tarefa A' }, actor);
      const taskB = await TaskService.createTask(projectId, { title: 'Tarefa B' }, actor);

      // A BLOCKS B
      await TaskService.addRelation(taskA.id, taskB.id, RelationType.BLOCKS, actor);

      // B BLOCKS A causaria ciclo direto (A -> B -> A)
      await expect(
        TaskService.addRelation(taskB.id, taskA.id, RelationType.BLOCKS, actor)
      ).rejects.toThrow(ValidationError);
    });

    it('deve detectar ciclo transitivo em cadeia: A -> B -> C -> A', async () => {
      const taskA = await TaskService.createTask(projectId, { title: 'Tarefa A' }, actor);
      const taskB = await TaskService.createTask(projectId, { title: 'Tarefa B' }, actor);
      const taskC = await TaskService.createTask(projectId, { title: 'Tarefa C' }, actor);

      // A BLOCKS B
      await TaskService.addRelation(taskA.id, taskB.id, RelationType.BLOCKS, actor);
      // B BLOCKS C
      await TaskService.addRelation(taskB.id, taskC.id, RelationType.BLOCKS, actor);

      // C BLOCKS A causaria ciclo transitivo (A -> B -> C -> A)
      await expect(
        TaskService.addRelation(taskC.id, taskA.id, RelationType.BLOCKS, actor)
      ).rejects.toThrow(ValidationError);
    });

    it('deve impedir criação simultânea de ciclos sob concorrência via lock do projeto (T12)', async () => {
      const taskA = await TaskService.createTask(projectId, { title: 'Tarefa Concorrente A' }, actor);
      const taskB = await TaskService.createTask(projectId, { title: 'Tarefa Concorrente B' }, actor);

      // Dispara simultaneamente:
      // Req 1: A BLOCKS B
      // Req 2: B BLOCKS A
      const results = await Promise.allSettled([
        TaskService.addRelation(taskA.id, taskB.id, RelationType.BLOCKS, actor),
        TaskService.addRelation(taskB.id, taskA.id, RelationType.BLOCKS, actor),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exatamente UMA deve ter sucesso e a outra deve ser rejeitada por ciclo
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
    });

    it('deve expor relações normalizadas de forma legível no getTask (3.4-d)', async () => {
      const taskA = await TaskService.createTask(projectId, { title: 'Predecessora' }, actor);
      const taskB = await TaskService.createTask(projectId, { title: 'Sucessora' }, actor);

      await TaskService.addRelation(taskA.id, taskB.id, RelationType.BLOCKS, actor);

      // Ao consultar taskA, ela deve mostrar que "Bloqueia taskB"
      const taskADTO = await TaskService.getTask(taskA.id, actor);
      expect(taskADTO?.relations).toBeDefined();
      const relA = taskADTO?.relations?.find((r) => r.relatedTask.id === taskB.id);
      expect(relA?.type).toBe('BLOCKS');

      // Ao consultar taskB, ela deve mostrar que é "Bloqueada por taskA"
      const taskBDTO = await TaskService.getTask(taskB.id, actor);
      expect(taskBDTO?.relations).toBeDefined();
      const relB = taskBDTO?.relations?.find((r) => r.relatedTask.id === taskA.id);
      expect(relB?.type).toBe('BLOCKED_BY');
    });
  });
});
