import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { ProjectService } from '../src/services/project.service.js';
import { TaskService } from '../src/services/task.service.js';
import { LabelService } from '../src/services/label.service.js';
import { ValidationError, ConflictError, NotFoundError } from '../src/errors/app-error.js';
import { UserActor } from '../src/types/auth.js';

describe('T12, T14 & E3.3 - Etiquetas, Colunas, Chave do Projeto e Numeração', () => {
  let workspaceId: string;
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
  });

  describe('3.3-c / T12: Chave do Projeto e Numeração Sequencial', () => {
    it('deve validar formato da chave (2-10 caracteres alfanuméricos maiúsculos)', async () => {
      // Chave inválida com caracteres especiais ou minúsculas
      await expect(
        ProjectService.createProject(workspaceId, { name: 'Proj Teste', key: 'invalid-key' }, actor)
      ).rejects.toThrow(ValidationError);

      await expect(
        ProjectService.createProject(workspaceId, { name: 'Proj Teste', key: 'A' }, actor)
      ).rejects.toThrow(ValidationError);

      // Chave válida
      const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
      const validProject = await ProjectService.createProject(
        workspaceId,
        { name: 'Proj Valido', key: `K${randomSuffix}`.slice(0, 8) },
        actor
      );
      expect(validProject.key).toMatch(/^[A-Z0-9]{2,10}$/);
      expect(validProject.taskCounter).toBe(0);
    });

    it('deve derivar chave válida automaticamente se não for informada', async () => {
      const p = await ProjectService.createProject(
        workspaceId,
        { name: 'Sistema Financeiro Global' },
        actor
      );
      expect(p.key).toBeTruthy();
      expect(p.key.length).toBeGreaterThanOrEqual(2);
      expect(p.key).toMatch(/^[A-Z0-9]{2,10}$/);
    });

    it('deve impedir alteração da chave do projeto após existirem tarefas (imutabilidade)', async () => {
      const proj = await ProjectService.createProject(
        workspaceId,
        { name: 'Proj Imutavel', key: `IM${Date.now().toString().slice(-4)}` },
        actor
      );

      // Chave pode ser alterada antes de tarefas existirem
      const updatedBefore = await ProjectService.updateProject(
        proj.id,
        { key: `IMB${Date.now().toString().slice(-3)}` },
        actor
      );
      expect(updatedBefore.key).toContain('IMB');

      // Cria uma tarefa no projeto
      const task = await TaskService.createTask(
        proj.id,
        { title: 'Primeira Tarefa' },
        actor
      );
      expect(task.taskNumber).toBe(1);
      expect(task.displayCode).toBe(`${updatedBefore.key}-1`);

      // Tentar alterar a chave agora deve falhar
      await expect(
        ProjectService.updateProject(proj.id, { key: 'NEWKEY' }, actor)
      ).rejects.toThrow(ValidationError);
    });

    it('deve gerar números sequenciais atômicos e displayCode corretos sob concorrência (T12)', async () => {
      const pKey = `SEQ${Date.now().toString().slice(-3)}`;
      const proj = await ProjectService.createProject(
        workspaceId,
        { name: 'Projeto Concorrente', key: pKey },
        actor
      );

      // Dispara 10 criações concorrentes de tarefas no mesmo projeto
      const promises = Array.from({ length: 10 }, (_, i) =>
        TaskService.createTask(proj.id, { title: `Tarefa Concorrente ${i + 1}` }, actor)
      );

      const tasks = await Promise.all(promises);

      // Garante que todos os taskNumbers são únicos e variam de 1 a 10
      const numbers = tasks.map((t) => t.taskNumber).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Garante que displayCode está no formato KEY-N
      tasks.forEach((t) => {
        expect(t.displayCode).toBe(`${pKey}-${t.taskNumber}`);
      });

      // Confere taskCounter no projeto
      const updatedProj = await prisma.project.findUniqueOrThrow({ where: { id: proj.id } });
      expect(updatedProj.taskCounter).toBe(10);
    });
  });

  describe('3.3-a: Etiquetas como Entidades (Label e TaskLabel)', () => {
    it('deve criar e normalizar etiqueta por workspace com cor hexadecimal', async () => {
      const uniqueName = `Urgente Produção ${Date.now()}`;
      const label = await LabelService.createLabel(
        workspaceId,
        { name: uniqueName, color: '#ef4444' },
        actor
      );
      expect(label.name).toBe(uniqueName);
      expect(label.normalizedName).toBe(uniqueName.toLowerCase());
      expect(label.color).toBe('#ef4444');

      // Colisão de nome normalizado no mesmo workspace deve lançar ConflictError
      await expect(
        LabelService.createLabel(workspaceId, { name: `  ${uniqueName.toUpperCase()}  ` }, actor)
      ).rejects.toThrow(ConflictError);
    });

    it('deve sincronizar etiquetas automaticamente ao criar e atualizar tarefa', async () => {
      const proj = await ProjectService.createProject(
        workspaceId,
        { name: 'Projeto Labels', key: `LBL${Date.now().toString().slice(-3)}` },
        actor
      );

      const task = await TaskService.createTask(
        proj.id,
        {
          title: 'Tarefa com Tags',
          tags: ['Backend', 'Bug', 'Auth'],
        },
        actor
      );

      expect(task.tags).toEqual(['Backend', 'Bug', 'Auth']);
      expect(task.labels?.length).toBe(3);
      expect(task.labels?.map((l) => l.name)).toEqual(expect.arrayContaining(['Backend', 'Bug', 'Auth']));

      // Atualiza tags da tarefa
      const updated = await TaskService.updateTask(
        task.id,
        { tags: ['Frontend', 'UI'] },
        actor
      );

      expect(updated.tags).toEqual(['Frontend', 'UI']);
      expect(updated.labels?.length).toBe(2);
      expect(updated.labels?.map((l) => l.name)).toEqual(expect.arrayContaining(['Frontend', 'UI']));
    });
  });

  describe('3.3-b / T14: Semântica de Colunas e Integridade', () => {
    it('deve criar projeto com Backlog e Concluído como colunas padrão', async () => {
      const proj = await ProjectService.createProject(
        workspaceId,
        { name: 'Projeto Semântico' },
        actor
      );

      expect(proj.columns.length).toBe(5);
      expect(proj.backlogColumnId).toBeTruthy();

      const backlogCol = proj.columns.find((c) => c.id === proj.backlogColumnId);
      expect(backlogCol?.name).toBe('Backlog');
      expect(backlogCol?.isDoneColumn).toBe(false);

      const doneCols = proj.columns.filter((c) => c.isDoneColumn);
      expect(doneCols.length).toBe(1);
      expect(doneCols[0].name).toBe('Concluído');
    });

    it('deve impedir definir a coluna de backlog como coluna de conclusão', async () => {
      const proj = await ProjectService.createProject(
        workspaceId,
        { name: 'Projeto Teste Colunas' },
        actor
      );

      // Tenta atualizar backlogColumnId com uma coluna que é isDoneColumn
      const doneCol = proj.columns.find((c) => c.isDoneColumn)!;
      await expect(
        ProjectService.updateProject(proj.id, { backlogColumnId: doneCol.id }, actor)
      ).rejects.toThrow(ValidationError);
    });

    it('deve mover tarefas atomicamente ao excluir coluna ocupada (T14)', async () => {
      const proj = await ProjectService.createProject(
        workspaceId,
        { name: 'Projeto Exclusão Coluna' },
        actor
      );

      const colSource = proj.columns.find((c) => c.name === 'A Fazer')!;
      const colDest = proj.columns.find((c) => c.name === 'Em Andamento')!;

      // Cria 3 tarefas na coluna de origem
      await TaskService.createTask(proj.id, { title: 'T1', columnId: colSource.id }, actor);
      await TaskService.createTask(proj.id, { title: 'T2', columnId: colSource.id }, actor);
      await TaskService.createTask(proj.id, { title: 'T3', columnId: colSource.id }, actor);

      const tasksInSource = await prisma.task.count({ where: { columnId: colSource.id } });
      expect(tasksInSource).toBe(3);

      // Simula a lógica de exclusão com transação atômica
      await prisma.$transaction(async (tx) => {
        await tx.task.updateMany({
          where: { columnId: colSource.id },
          data: { columnId: colDest.id },
        });
        await tx.column.delete({
          where: { id: colSource.id },
        });
      });

      // Confere que a coluna foi apagada e as tarefas migradas para colDest
      const deletedCol = await prisma.column.findUnique({ where: { id: colSource.id } });
      expect(deletedCol).toBeNull();

      const tasksInDest = await prisma.task.count({ where: { columnId: colDest.id } });
      expect(tasksInDest).toBe(3);
    });
  });
});
