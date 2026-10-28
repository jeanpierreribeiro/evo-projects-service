import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShareService } from '../src/services/share.service.js';
import { buildPublicCard } from '../src/share/public-card.js';
import { hashToken, verifyPin } from '../src/share/crypto.js';
import prisma from '../src/db/prisma.js';
import { ValidationError, ConflictError, NotFoundError } from '../src/errors/app-error.js';
import { UserActor } from '../src/types/auth.js';

describe('T10 & E2.2 - Public Card Builder & ShareService', () => {
  const dummyTask = {
    id: 'task-test-123',
    taskNumber: 42,
    workspaceId: 'ws-test-1',
    projectId: 'proj-test-1',
    title: 'Desenvolvimento do Portal Público',
    description: '## Detalhes Confidenciais da Tarefa\nMarkdown com dados do projeto.',
    priority: 'HIGH',
    column: { name: 'Em Andamento' },
    startDate: new Date('2026-11-01T00:00:00Z'),
    dueDate: new Date('2026-11-15T00:00:00Z'),
    subtasks: [
      { id: 'sub-1', title: 'Implementar backend', completed: true },
      { id: 'sub-2', title: 'Desenvolver UI', completed: false },
    ],
    resources: [
      { id: 'res-public', title: 'Figma Design', url: 'https://figma.com/file/123', type: 'figma' },
      { id: 'res-private', title: 'Planilha Interna de Custos', url: 'https://drive.google.com/sheet/private', type: 'drive' },
    ],
    // Campos confidenciais internos que NUNCA podem vazar
    comments: [{ id: 'c-1', content: 'Conversa interna confidencial' }],
    timeEntries: [{ id: 't-1', durationMinutes: 120, userId: 'usr-1' }],
    activities: [{ id: 'a-1', action: 'created' }],
    assigneeName: 'Operador Secreto',
    assigneeId: 'usr-secret',
    updatedAt: new Date('2026-10-27T12:00:00Z'),
  };

  it('buildPublicCard: deve excluir estritamente dados internos e respeitar seções autorizadas (T10)', () => {
    // 1. Apenas res-public selecionado
    const card = buildPublicCard(dummyTask, {
      showDescription: true,
      showSubtasks: true,
      showResources: true,
      selectedResourceIds: ['res-public'],
      publicContentUpdatedAt: dummyTask.updatedAt,
    });

    expect(card.taskId).toBe('task-test-123');
    expect(card.title).toBe('Desenvolvimento do Portal Público');
    expect(card.description).toBe(dummyTask.description);
    expect(card.status).toBe('Em Andamento');
    expect(card.priority).toBe('HIGH');
    expect(card.checklist).toHaveLength(2);
    expect(card.checklist![0]).toEqual({ id: 'sub-1', title: 'Implementar backend', completed: true });

    // Apenas o recurso explicitamente selecionado aparece
    expect(card.resources).toHaveLength(1);
    expect(card.resources![0].id).toBe('res-public');
    expect(card.resources![0].url).toBe('https://figma.com/file/123');

    // Campos internos e confidenciais NUNCA podem estar presentes
    expect((card as any).comments).toBeUndefined();
    expect((card as any).timeEntries).toBeUndefined();
    expect((card as any).activities).toBeUndefined();
    expect((card as any).assigneeId).toBeUndefined();
    expect((card as any).assigneeName).toBeUndefined();
  });

  it('buildPublicCard: quando showDescription for false, oculta descrição', () => {
    const card = buildPublicCard(dummyTask, {
      showDescription: false,
      showSubtasks: true,
      showResources: false,
    });

    expect(card.description).toBeNull();
    expect(card.resources).toBeUndefined();
    expect(card.checklist).toBeDefined();
  });

  it('buildPublicCard: novo recurso não selecionado nasce privado', () => {
    const card = buildPublicCard(dummyTask, {
      showDescription: true,
      showSubtasks: true,
      showResources: true,
      selectedResourceIds: [], // Nenhum selecionado
    });

    expect(card.resources).toEqual([]);
  });
});
