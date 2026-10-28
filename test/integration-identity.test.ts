import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntegrationService } from '../src/services/integration.service.js';
import prisma from '../src/db/prisma.js';

vi.mock('../src/db/prisma.js', () => ({
  default: {
    servicePrincipal: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    serviceCredential: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    integrationGrant: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
  },
}));

describe('T06 - Identidade de Serviço, Credenciais e Grants (E1.7)', () => {
  const principalId = 'sp-agent-crm-001';
  const workspaceId = 'ws-corp-123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve criar um ServicePrincipal com identidade própria de automação', async () => {
    (prisma.servicePrincipal.create as any).mockResolvedValue({
      id: principalId,
      name: 'Evo Bot Agent',
      description: 'Atendimento WhatsApp CRM',
      isActive: true,
    });

    const principal = await IntegrationService.createPrincipal({
      name: 'Evo Bot Agent',
      description: 'Atendimento WhatsApp CRM',
    });

    expect(principal.id).toBe(principalId);
    expect(principal.name).toBe('Evo Bot Agent');
  });

  it('deve emitir credencial com chave formatada, salvando apenas o SHA-256 no banco', async () => {
    (prisma.servicePrincipal.findUnique as any).mockResolvedValue({ id: principalId });
    (prisma.serviceCredential.create as any).mockImplementation(({ data }: any) => ({
      id: 'cred-123',
      ...data,
    }));

    const result = await IntegrationService.issueCredential(principalId, 30);

    expect(result.credentialId).toBe('cred-123');
    expect(result.keyPrefix).toMatch(/^sp_[0-9a-f]{8}$/);
    expect(result.secretKey).toContain(result.keyPrefix);
    expect(result.expiresAt).toBeInstanceOf(Date);

    // Verifica que o hash NÃO é o texto puro
    const passedData = (prisma.serviceCredential.create as any).mock.calls[0][0].data;
    expect(passedData.secretHash).not.toBe(result.secretKey);
    expect(passedData.secretHash.length).toBe(64); // SHA-256 hex length
  });

  it('deve autenticar chave de serviço e retornar grants ativos', async () => {
    const rawKey = 'sp_abcd1234_my_super_secret_token_12345';
    const parts = rawKey.split('_');
    const prefix = `${parts[0]}_${parts[1]}`;

    (prisma.serviceCredential.findFirst as any).mockResolvedValue({
      id: 'cred-123',
      keyPrefix: prefix,
      principal: {
        id: principalId,
        name: 'Evo Bot Agent',
        isActive: true,
        grants: [
          {
            id: 'grant-1',
            workspaceId,
            tools: ['list_tasks', 'create_task'],
            mode: 'internal',
            canShare: false,
          },
        ],
      },
    });

    const auth = await IntegrationService.authenticateKey(rawKey);

    expect(auth).not.toBeNull();
    expect(auth?.principal.id).toBe(principalId);
    expect(auth?.grants.length).toBe(1);
    expect(auth?.grants[0].tools).toContain('create_task');
  });

  it('deve recusar chave após revogação', async () => {
    (prisma.serviceCredential.findFirst as any).mockResolvedValue(null);

    const auth = await IntegrationService.authenticateKey('sp_revoked_key_12345');
    expect(auth).toBeNull();
  });
});
