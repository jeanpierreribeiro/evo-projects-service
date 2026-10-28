import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { TaskService } from '../src/services/task.service.js';
import { WorkspaceService } from '../src/services/workspace.service.js';
import { ValidationError } from '../src/errors/app-error.js';
import { UserActor } from '../src/types/auth.js';
import {
  parseCivilDate,
  formatCivilDate,
  isValidIanaTimezone,
  getWorkspaceTodayCivilDate,
  isOverdueCivil,
} from '../src/utils/dates.js';

describe('T13 & E3.2 - Datas Civis, Fuso do Workspace e Estimativas em Minutos', () => {
  let workspaceId: string;
  let projectId: string;
  let columnId: string;
  let actor: UserActor;

  beforeEach(async () => {
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

  describe('3.2-a / I4: Datas Civis (@db.Date e YYYY-MM-DD)', () => {
    it('deve aceitar datas válidas em YYYY-MM-DD e rejeitar datas civis inexistentes', () => {
      // Data válida
      const valid = parseCivilDate('2026-11-15');
      expect(valid).not.toBeNull();
      expect(formatCivilDate(valid)).toBe('2026-11-15');

      // Fevereiro não-bissexto dia 29
      expect(() => parseCivilDate('2026-02-29')).toThrow(ValidationError);
      // Dia 31 em mês de 30 dias (abril)
      expect(() => parseCivilDate('2026-04-31')).toThrow(ValidationError);
      // Mês inválido
      expect(() => parseCivilDate('2026-13-01')).toThrow(ValidationError);
      // Formato com hora
      expect(() => parseCivilDate('2026-11-15T12:00:00Z')).toThrow(ValidationError);
    });

    it('deve rejeitar startDate posterior a dueDate (I4 / T13)', async () => {
      await expect(
        TaskService.createTask(
          projectId,
          {
            title: 'Tarefa com intervalo inválido',
            columnId,
            startDate: '2026-11-20',
            dueDate: '2026-11-10',
          },
          actor
        )
      ).rejects.toThrow(ValidationError);
    });

    it('deve aceitar startDate <= dueDate, inclusive no mesmo dia, e retornar strings civis idênticas', async () => {
      const task = await TaskService.createTask(
        projectId,
        {
          title: 'Tarefa Mesmo Dia',
          columnId,
          startDate: '2026-11-15',
          dueDate: '2026-11-15',
        },
        actor
      );

      expect(task.startDate).toBe('2026-11-15');
      expect(task.dueDate).toBe('2026-11-15');

      // Limpeza
      await TaskService.deleteTask(task.id, actor);
    });
  });

  describe('3.2-b / I5: Fuso do Workspace e Cálculo de Hoje/Atraso', () => {
    it('deve validar identificadores IANA e rejeitar fusos inválidos', () => {
      expect(isValidIanaTimezone('America/Sao_Paulo')).toBe(true);
      expect(isValidIanaTimezone('UTC')).toBe(true);
      expect(isValidIanaTimezone('America/New_York')).toBe(true);
      expect(isValidIanaTimezone('Asia/Tokyo')).toBe(true);

      expect(isValidIanaTimezone('Invalid/Timezone_123')).toBe(false);
      expect(isValidIanaTimezone('GMT-3')).toBe(false);
      expect(isValidIanaTimezone('')).toBe(false);
    });

    it('deve atualizar o fuso do workspace respeitando a validação IANA', async () => {
      const updated = await WorkspaceService.updateWorkspace(
        workspaceId,
        { timezone: 'America/New_York' },
        actor
      );
      expect(updated.timezone).toBe('America/New_York');

      // Restaura para o padrão America/Sao_Paulo
      const restored = await WorkspaceService.updateWorkspace(
        workspaceId,
        { timezone: 'America/Sao_Paulo' },
        actor
      );
      expect(restored.timezone).toBe('America/Sao_Paulo');

      // Tenta fuso inválido
      await expect(
        WorkspaceService.updateWorkspace(
          workspaceId,
          { timezone: 'Fuso_Inexistente' },
          actor
        )
      ).rejects.toThrow(ValidationError);
    });

    it('deve calcular corretamente virada de dia e atraso ancorado no fuso do workspace (I5)', () => {
      const todaySaoPaulo = getWorkspaceTodayCivilDate('America/Sao_Paulo');
      expect(todaySaoPaulo).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Uma data no passado deve constar como atrasada
      expect(isOverdueCivil('2020-01-01', 'America/Sao_Paulo')).toBe(true);

      // Uma data no futuro distante NÃO deve constar como atrasada
      expect(isOverdueCivil('2099-12-31', 'America/Sao_Paulo')).toBe(false);
    });
  });

  describe('3.2-c / I6: Estimativa em Minutos e Limites', () => {
    it('deve persistir estimatedMinutes inteiro e aceitar nulo como não informada (nunca zero)', async () => {
      // 1. Criar tarefa com 90 minutos (1h 30min)
      const task = await TaskService.createTask(
        projectId,
        {
          title: 'Tarefa Estimativa 90m',
          columnId,
          estimatedMinutes: 90,
        },
        actor
      );

      expect(task.estimatedMinutes).toBe(90);
      expect(task.estimatedHours).toBe(1.5);

      // 2. Atualizar para nulo (não informada)
      const updated = await TaskService.updateTask(
        task.id,
        {
          estimatedMinutes: null,
          expectedVersion: task.version,
        },
        actor
      );

      expect(updated.estimatedMinutes).toBeNull();
      expect(updated.estimatedHours).toBeNull();

      // Limpeza
      await TaskService.deleteTask(task.id, actor);
    });

    it('deve rejeitar estimativas negativas ou iguais a zero (I6)', async () => {
      await expect(
        TaskService.createTask(
          projectId,
          {
            title: 'Tarefa Estimativa Inválida',
            columnId,
            estimatedMinutes: 0,
          },
          actor
        )
      ).rejects.toThrow(ValidationError);

      await expect(
        TaskService.createTask(
          projectId,
          {
            title: 'Tarefa Estimativa Negativa',
            columnId,
            estimatedMinutes: -60,
          },
          actor
        )
      ).rejects.toThrow(ValidationError);
    });

    it('deve aceitar estimatedHours legado e converter com arredondamento explícito (3.2-c)', async () => {
      const task = await TaskService.createTask(
        projectId,
        {
          title: 'Tarefa Legada Horas',
          columnId,
          estimatedHours: 2.5,
        },
        actor
      );

      expect(task.estimatedMinutes).toBe(150); // 2.5 * 60 = 150
      expect(task.estimatedHours).toBe(2.5);

      // Limpeza
      await TaskService.deleteTask(task.id, actor);
    });
  });
});
