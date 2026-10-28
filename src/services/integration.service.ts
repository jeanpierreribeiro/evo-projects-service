import crypto from 'node:crypto';
import prisma from '../db/prisma.js';
import { NotFoundError, ValidationError } from '../errors/app-error.js';

export class IntegrationService {
  /**
   * Cria um ServicePrincipal com identidade própria de automação/serviço.
   */
  static async createPrincipal(data: { name: string; description?: string }) {
    if (!data.name?.trim()) throw new ValidationError('Nome do ServicePrincipal é obrigatório.');

    return prisma.servicePrincipal.create({
      data: {
        name: data.name.trim(),
        description: data.description?.trim(),
        isActive: true,
      },
    });
  }

  /**
   * Emite uma nova credencial com segredo aleatório de alta entropia.
   * O segredo é devolvido uma única vez; no banco apenas o SHA-256 é armazenado (E1.7-a).
   */
  static async issueCredential(principalId: string, expiresInDays = 90) {
    const principal = await prisma.servicePrincipal.findUnique({ where: { id: principalId } });
    if (!principal) throw new NotFoundError('ServicePrincipal não encontrado.');

    const keyPrefix = `sp_${crypto.randomBytes(4).toString('hex')}`;
    const rawSecret = crypto.randomBytes(32).toString('base64url');
    const secretHash = crypto.createHash('sha256').update(rawSecret).digest('hex');
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const credential = await prisma.serviceCredential.create({
      data: {
        principalId: principal.id,
        keyPrefix,
        secretHash,
        expiresAt,
      },
    });

    const fullKey = `${keyPrefix}_${rawSecret}`;

    return {
      credentialId: credential.id,
      principalId: principal.id,
      keyPrefix,
      secretKey: fullKey, // Apenas exibido nesta resposta de emissão
      expiresAt,
    };
  }

  /**
   * Revoga uma credencial de serviço.
   */
  static async revokeCredential(credentialId: string) {
    const cred = await prisma.serviceCredential.findUnique({ where: { id: credentialId } });
    if (!cred) throw new NotFoundError('Credencial não encontrada.');

    return prisma.serviceCredential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Concede acesso explícito (Grant) a um workspace/projeto com ferramentas e campos permitidos.
   */
  static async createGrant(
    principalId: string,
    data: {
      workspaceId: string;
      projectId?: string;
      tools: string[];
      allowedFields?: string[];
      mode?: string;
      canShare?: boolean;
      expiresInDays?: number;
    }
  ) {
    const principal = await prisma.servicePrincipal.findUnique({ where: { id: principalId } });
    if (!principal) throw new NotFoundError('ServicePrincipal não encontrado.');

    const workspace = await prisma.workspace.findUnique({ where: { id: data.workspaceId } });
    if (!workspace) throw new NotFoundError('Workspace não encontrado.');

    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    return prisma.integrationGrant.create({
      data: {
        principalId: principal.id,
        workspaceId: workspace.id,
        projectId: data.projectId || null,
        tools: data.tools || [],
        allowedFields: data.allowedFields || [],
        mode: data.mode || 'internal',
        canShare: Boolean(data.canShare),
        expiresAt,
      },
    });
  }

  /**
   * Revoga um grant concedido.
   */
  static async revokeGrant(grantId: string) {
    const grant = await prisma.integrationGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw new NotFoundError('Grant de integração não encontrado.');

    return prisma.integrationGrant.update({
      where: { id: grantId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Autentica uma credencial de serviço por chave `sp_..._...` (E1.7-b).
   */
  static async authenticateKey(rawKey: string) {
    if (!rawKey || !rawKey.startsWith('sp_')) return null;

    const parts = rawKey.split('_');
    if (parts.length < 3) return null;

    const prefix = `${parts[0]}_${parts[1]}`;
    const secret = parts.slice(2).join('_');
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

    const cred = await prisma.serviceCredential.findFirst({
      where: {
        keyPrefix: prefix,
        secretHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        principal: { isActive: true },
      },
      include: {
        principal: {
          include: {
            grants: {
              where: {
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              },
            },
          },
        },
      },
    });

    if (!cred) return null;

    return {
      principal: cred.principal,
      grants: cred.principal.grants,
    };
  }
}
