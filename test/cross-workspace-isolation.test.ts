import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestJwt } from './helpers/auth.js';
import { FIXTURE_WORKSPACES, FIXTURE_USERS } from './helpers/fixtures.js';
import prisma from '../src/db/prisma.js';
import { AuthClient } from '../src/auth/auth-client.js';

// Mock do AuthClient para validação de sessão ativa no teste de isolamento
vi.mock('../src/auth/auth-client.js', () => ({
  AuthClient: {
    validateToken: vi.fn(),
  },
  AuthServiceUnavailableError: class extends Error {},
}));

// Mock do prisma para isolamento determinístico do teste T03
vi.mock('../src/db/prisma.js', () => ({
  default: {
    workspaceMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    column: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    task: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    notification: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    activity: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

describe('T03 - Isolamento Estrito entre Workspaces (E1.4-c)', () => {
  const app = buildApp();
  const wsAlpha = FIXTURE_WORKSPACES.alpha;
  const wsBeta = FIXTURE_WORKSPACES.beta;
  const userAlpha = FIXTURE_USERS.admin; // Admin do Workspace Alpha

  let alphaToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    (AuthClient.validateToken as any).mockResolvedValue({
      valid: true,
      user: {
        id: userAlpha.id,
        email: userAlpha.email,
        name: userAlpha.name,
        role: 'ADMIN',
      },
    });

    alphaToken = await createTestJwt({
      sub: userAlpha.id,
      email: userAlpha.email,
      name: userAlpha.name,
    });

    // Mock: userAlpha é membro APENAS do wsAlpha, NÃO do wsBeta
    (prisma.workspaceMember.findUnique as any).mockImplementation(
      ({ where }: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        if (workspaceId === wsAlpha.id && userId === userAlpha.id) {
          return { role: 'ADMIN', active: true };
        }
        return null;
      }
    );

    // Mock dos recursos pertencentes ao wsBeta
    (prisma.workspace.findUnique as any).mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === wsBeta.id) return { id: wsBeta.id, name: wsBeta.name, slug: wsBeta.slug };
      if (where.id === wsAlpha.id) return { id: wsAlpha.id, name: wsAlpha.name, slug: wsAlpha.slug };
      return null;
    });

    (prisma.workspace.findFirst as any).mockImplementation(({ where }: any) => {
      const idOrSlug = where?.OR?.[0]?.id;
      if (idOrSlug === wsBeta.id || idOrSlug === wsBeta.slug) return { id: wsBeta.id, name: wsBeta.name, slug: wsBeta.slug, members: [] };
      return null;
    });

    (prisma.project.findUnique as any).mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'proj-beta-1') {
        return { id: 'proj-beta-1', workspaceId: wsBeta.id, name: 'Project Beta', isArchived: false };
      }
      return null;
    });

    (prisma.task.findUnique as any).mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'task-beta-1') {
        return {
          id: 'task-beta-1',
          workspaceId: wsBeta.id,
          projectId: 'proj-beta-1',
          title: 'Task Beta',
          project: { id: 'proj-beta-1', workspaceId: wsBeta.id, isArchived: false },
        };
      }
      return null;
    });
  });

  it('deve retornar 404 ao tentar ler detalhes de workspace do qual não é membro', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/workspaces/${wsBeta.id}`,
      headers: { authorization: `Bearer ${alphaToken}` },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('NOT_FOUND');
    expect(body.requestId).toBeDefined();
  });

  it('deve retornar 404 ao tentar listar projetos de outro workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/workspaces/${wsBeta.id}/projects`,
      headers: { authorization: `Bearer ${alphaToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('deve retornar 404 ao tentar criar projeto em outro workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/workspaces/${wsBeta.id}/projects`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { name: 'Tentativa Invasão' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('deve retornar 404 ao tentar acessar projeto pertencente a outro workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/projects/proj-beta-1',
      headers: { authorization: `Bearer ${alphaToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('deve retornar 404 ao tentar acessar tarefas de projeto de outro workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/projects/proj-beta-1/tasks',
      headers: { authorization: `Bearer ${alphaToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('deve retornar 404 ao tentar acessar ou manipular tarefa de outro workspace', async () => {
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/tasks/task-beta-1',
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    expect(getRes.statusCode).toBe(404);

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/tasks/task-beta-1',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { title: 'Título Alterado Ilicitamente' },
    });
    expect(putRes.statusCode).toBe(404);

    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/tasks/task-beta-1',
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    expect(delRes.statusCode).toBe(404);
  });

  it('deve retornar 404 ao tentar acessar dashboard ou inbox de outro workspace', async () => {
    const dashRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/workspaces/${wsBeta.id}/dashboard`,
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    expect(dashRes.statusCode).toBe(404);

    const inboxRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/workspaces/${wsBeta.id}/inbox`,
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    expect(inboxRes.statusCode).toBe(404);
  });

  it('deve retornar 404 ao tentar adicionar ou gerenciar membros de outro workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/workspaces/${wsBeta.id}/members`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: {
        userId: 'some-user',
        email: 'user@corp.com',
        name: 'User',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});
