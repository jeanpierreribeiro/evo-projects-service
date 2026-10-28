import { describe, it, expect } from 'vitest';
import { toTaskInternalDTO, toTaskInternalListDTO } from '../src/dto/task-dto.js';

describe('T07 - Sanitização e DTOs por Finalidade (E1.5-a)', () => {
  const contaminatedTask = {
    id: 'task-clean-1',
    taskNumber: 101,
    workspaceId: 'ws-123',
    projectId: 'proj-456',
    columnId: 'col-789',
    title: 'Desenvolver feature de segurança',
    description: 'Implementar autorização e DTOs',
    priority: 'HIGH',
    assigneeId: 'usr-1',
    assigneeName: 'Carlos Dev',
    assigneeAvatar: 'https://cdn.jpros.com/avatar.png',
    position: 0,
    startDate: new Date('2026-10-27T10:00:00Z'),
    dueDate: new Date('2026-11-05T18:00:00Z'),
    estimatedHours: 16,
    tags: ['seguranca', 'p0'],
    isArchived: false,

    // Dados legados e sensíveis que NUNCA devem aparecer no DTO
    approvalToken: 'nano_token_secret_12345',
    approvalPin: '1234',
    approvalFeedback: 'Precisa melhorar UX',
    approvedIp: '192.168.1.100',
    tokenHash: 'sha256_hash_value',
    pinHash: 'argon2_pin_hash_value',
    integrationSecret: 'super_secret_credentials',

    createdAt: new Date('2026-10-27T09:00:00Z'),
    updatedAt: new Date('2026-10-27T11:00:00Z'),
  };

  it('deve mapear para TaskInternalDTO preservando campos operacionais', () => {
    const dto = toTaskInternalDTO(contaminatedTask);
    expect(dto).not.toBeNull();
    expect(dto?.id).toBe('task-clean-1');
    expect(dto?.taskNumber).toBe(101);
    expect(dto?.title).toBe('Desenvolver feature de segurança');
    expect(dto?.priority).toBe('HIGH');
    expect(dto?.estimatedHours).toBe(16);
    expect(dto?.tags).toEqual(['seguranca', 'p0']);
  });

  it('PROIBIDO: nenhuma resposta deve conter pin, token, hash, feedback ou credenciais', () => {
    const dto = toTaskInternalDTO(contaminatedTask);
    const keys = Object.keys(dto || {});

    // Regex para detectar qualquer menção a chaves proibidas
    const forbiddenPatterns = [/pin/i, /token/i, /hash/i, /secret/i, /credential/i, /approvedIp/i, /feedback/i];

    for (const key of keys) {
      for (const pattern of forbiddenPatterns) {
        expect(key, `A chave proibida "${key}" vazou no DTO!`).not.toMatch(pattern);
      }
    }

    // Validações diretas
    expect((dto as any).approvalToken).toBeUndefined();
    expect((dto as any).approvalPin).toBeUndefined();
    expect((dto as any).approvalFeedback).toBeUndefined();
    expect((dto as any).approvedIp).toBeUndefined();
    expect((dto as any).tokenHash).toBeUndefined();
    expect((dto as any).pinHash).toBeUndefined();
    expect((dto as any).integrationSecret).toBeUndefined();
  });

  it('deve sanitizar listas de tarefas em lote com toTaskInternalListDTO', () => {
    const list = toTaskInternalListDTO([contaminatedTask, { ...contaminatedTask, id: 'task-clean-2' }]);
    expect(list.length).toBe(2);
    for (const item of list) {
      expect((item as any).approvalPin).toBeUndefined();
      expect((item as any).approvalToken).toBeUndefined();
    }
  });
});
