import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { TaskService } from '../src/services/task.service.js';
import { UserActor } from '../src/types/auth.js';
import { WorkspaceRole } from '@prisma/client';

describe('E3.5-b / T11 - Reordenação de Tarefas e Colunas sob Concorrência', () => {
  let workspaceId: string;
  let projectId: string;
  let colAId: string;
  let colBId: string;
  let actor: UserActor;

  beforeEach(async () => {
    const ws = await prisma.workspace.findUniqueOrThrow({
      where: { slug: 'operacao-principal' },
      include: {
        members: { where: { status: 'ACTIVE', role: 'ADMIN' } },
      },
    });

    workspaceId = ws.id;
    actor = {
      type: 'user',
      id: ws.members[0].userId,
      role: 'ADMIN',
      tokenWorkspaceId: workspaceId,
    };

    const unique = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testProj = await prisma.project.create({
      data: {
        workspaceId,
        name: `Reorder Test Proj ${unique}`,
        slug: `reorder-proj-${unique}`,
        key: `RO${Math.floor(Math.random() * 899 + 100)}`,
        columns: {
          create: [
            { name: 'Coluna Alpha', position: 0 },
            { name: 'Coluna Beta', position: 1 },
          ],
        },
      },
      include: { columns: { orderBy: { position: 'asc' } } },
    });

    projectId = testProj.id;
    colAId = testProj.columns[0].id;
    colBId = testProj.columns[1].id;
  });

  afterEach(async () => {
    if (projectId) {
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    }
  });

  it('deve mover tarefa entre colunas, reordenar índices inteiros e incrementar orderVersion em ambas (E3.5-b)', async () => {
    // 1. Obtém orderVersion inicial das duas colunas
    const initialColA = await prisma.column.findUniqueOrThrow({ where: { id: colAId } });
    const initialColB = await prisma.column.findUniqueOrThrow({ where: { id: colBId } });

    // 2. Cria 3 tarefas na Coluna A
    const t1 = await TaskService.createTask(projectId, { title: 'T1 Col A', columnId: colAId }, actor);
    const t2 = await TaskService.createTask(projectId, { title: 'T2 Col A', columnId: colAId }, actor);
    const t3 = await TaskService.createTask(projectId, { title: 'T3 Col A', columnId: colAId }, actor);

    // 3. Move t2 da Coluna A para a Coluna B na posição 0
    const moved = await TaskService.moveTask(t2.id, colBId, 0, actor);
    expect(moved.columnId).toBe(colBId);
    expect(moved.position).toBe(0);
    expect(moved.version).toBeGreaterThan(t2.version);

    // 4. Verifica tarefas restantes na Coluna A: posições devem ser inteiras consecutivas (0 e 1)
    const remainingColA = await prisma.task.findMany({
      where: { columnId: colAId },
      orderBy: { position: 'asc' },
    });
    expect(remainingColA.map((t) => t.id)).toEqual([t1.id, t3.id]);
    expect(remainingColA[0].position).toBe(0);
    expect(remainingColA[1].position).toBe(1);

    // 5. Verifica tarefas na Coluna B: t2 deve estar em position 0
    const colBTasks = await prisma.task.findMany({
      where: { columnId: colBId },
      orderBy: { position: 'asc' },
    });
    const foundInB = colBTasks.find((t) => t.id === t2.id);
    expect(foundInB).toBeDefined();
    expect(foundInB?.position).toBe(0);

    // 6. orderVersion deve ter sido incrementada em ambas as colunas
    const updatedColA = await prisma.column.findUniqueOrThrow({ where: { id: colAId } });
    const updatedColB = await prisma.column.findUniqueOrThrow({ where: { id: colBId } });
    expect(updatedColA.orderVersion).toBeGreaterThan(initialColA.orderVersion);
    expect(updatedColB.orderVersion).toBeGreaterThan(initialColB.orderVersion);
  });

  it('deve reordenar tarefas na mesma coluna mantendo posições consecutivas (E3.5-b)', async () => {
    const tA = await TaskService.createTask(projectId, { title: 'Task Alpha', columnId: colAId }, actor);
    const tB = await TaskService.createTask(projectId, { title: 'Task Beta', columnId: colAId }, actor);
    const tC = await TaskService.createTask(projectId, { title: 'Task Gamma', columnId: colAId }, actor);

    // Move tC (que estava na posição 2) para a posição 0 (topo)
    await TaskService.moveTask(tC.id, colAId, 0, actor);

    const reordered = await prisma.task.findMany({
      where: { id: { in: [tA.id, tB.id, tC.id] } },
      orderBy: { position: 'asc' },
    });

    expect(reordered[0].id).toBe(tC.id);
    expect(reordered[0].position).toBe(0);
  });

  it('movimentos concorrentes entre colunas opostas não devem gerar deadlocks (T11 / E3.5-b)', async () => {
    // Cria uma tarefa na Col A e uma na Col B
    const taskInA = await TaskService.createTask(projectId, { title: 'In A', columnId: colAId }, actor);
    const taskInB = await TaskService.createTask(projectId, { title: 'In B', columnId: colBId }, actor);

    // Dispara simultaneamente: A -> B e B -> A
    const [resA, resB] = await Promise.all([
      TaskService.moveTask(taskInA.id, colBId, 0, actor),
      TaskService.moveTask(taskInB.id, colAId, 0, actor),
    ]);

    expect(resA.columnId).toBe(colBId);
    expect(resB.columnId).toBe(colAId);
  });
});
