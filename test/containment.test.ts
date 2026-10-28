import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { sanitizeTaskDTO } from '../src/dto/task-dto.js';

describe('T02 - Contenção de Exposição, Bloqueio de Bypass e DTOs (E1.2)', () => {
  const app = buildApp();

  it('deve rejeitar com 401 requisições sem Authorization, bloqueando bypass por x-user-*', async () => {
    // Tenta acessar rota autenticada enviando cabeçalhos de bypass
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/workspaces',
      headers: {
        'x-user-id': 'hacker-id',
        'x-user-role': 'admin',
        'x-user-email': 'hacker@malicious.com',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('deve retornar 410 LEGACY_FEATURE_REMOVED em rotas do portal legado', async () => {
    const previewRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/public/tasks/any-token-123/preview',
    });
    expect(previewRes.statusCode).toBe(410);
    expect(previewRes.json().code).toBe('LEGACY_FEATURE_REMOVED');

    const pinRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/public/tasks/any-token-123/validate-pin',
      payload: { pin: '1234' },
    });
    expect(pinRes.statusCode).toBe(410);
    expect(pinRes.json().code).toBe('LEGACY_FEATURE_REMOVED');

    const approveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/public/tasks/any-token-123/approve',
      payload: { pin: '1234' },
    });
    expect(approveRes.statusCode).toBe(410);
    expect(approveRes.json().code).toBe('LEGACY_FEATURE_REMOVED');
  });

  it('deve retornar 503 MCP_DISABLED nas rotas MCP enquanto desabilitado', async () => {
    const toolsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/mcp/tools',
    });
    expect(toolsRes.statusCode).toBe(503);
    expect(toolsRes.json().code).toBe('MCP_DISABLED');

    const callRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/mcp/call',
      payload: { name: 'list_workspaces' },
    });
    expect(callRes.statusCode).toBe(503);
    expect(callRes.json().code).toBe('MCP_DISABLED');
  });

  it('deve sanitizar DTOs removendo approvalToken, approvalPin, approvalFeedback e approvedIp', () => {
    const rawTask = {
      id: 'task-123',
      title: 'Tarefa Teste',
      taskNumber: 1,
      approvalToken: 'secret_token_123',
      approvalPin: '1234',
      approvalFeedback: 'Ajustar cor',
      approvedIp: '192.168.1.1',
      description: 'Descrição segura',
    };

    const sanitized = sanitizeTaskDTO(rawTask);
    expect(sanitized.id).toBe('task-123');
    expect(sanitized.title).toBe('Tarefa Teste');
    expect(sanitized.description).toBe('Descrição segura');
    expect((sanitized as any).approvalToken).toBeUndefined();
    expect((sanitized as any).approvalPin).toBeUndefined();
    expect((sanitized as any).approvalFeedback).toBeUndefined();
    expect((sanitized as any).approvedIp).toBeUndefined();
  });

  it('deve bloquear origens CORS não autorizadas', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        Origin: 'http://malicious-site.com',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('deve permitir origens CORS autorizadas', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
