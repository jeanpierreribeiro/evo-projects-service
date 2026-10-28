import prisma from '../db/prisma.js';
import { AccessService } from './access.service.js';
import { Actor } from '../types/auth.js';
import { NotFoundError, ValidationError, ConflictError } from '../errors/app-error.js';

export interface CreateContactLinkInput {
  crmInstanceId: string;
  crmContactId: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export interface CreateInboxRouteInput {
  crmInstanceId: string;
  crmInboxId: string;
  inboxName?: string;
  isExclusive?: boolean;
}

export interface SetConversationContextInput {
  projectId: string;
  crmInstanceId: string;
  crmConversationId: string;
  crmContactId?: string;
  expiresInHours?: number;
}

export class CrmLinkService {
  /**
   * Vincula um contato do CRM a um Workspace de Projetos (E4.1-a/b).
   * Restrito a ADMIN do workspace.
   */
  static async createContactLink(
    workspaceId: string,
    data: CreateContactLinkInput,
    actor: Actor
  ) {
    await AccessService.assertCan(actor, 'manage_crm_links', { workspaceId });

    if (!data.crmInstanceId?.trim()) throw new ValidationError('crmInstanceId é obrigatório.');
    if (!data.crmContactId?.trim()) throw new ValidationError('crmContactId é obrigatório.');

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, isArchived: true, deletedAt: true },
    });

    if (!workspace || workspace.isArchived || workspace.deletedAt) {
      throw new ValidationError('Workspace não encontrado ou inativo.');
    }

    const existing = await prisma.workspaceContactLink.findUnique({
      where: {
        workspaceId_crmInstanceId_crmContactId: {
          workspaceId,
          crmInstanceId: data.crmInstanceId.trim(),
          crmContactId: data.crmContactId.trim(),
        },
      },
    });

    if (existing) {
      throw new ConflictError('Este contato do CRM já está vinculado a este Workspace.');
    }

    return prisma.workspaceContactLink.create({
      data: {
        workspaceId,
        crmInstanceId: data.crmInstanceId.trim(),
        crmContactId: data.crmContactId.trim(),
        contactName: data.contactName?.trim() || null,
        contactPhone: data.contactPhone?.trim() || null,
        contactEmail: data.contactEmail?.trim() || null,
        createdByUserId: actor.id,
      },
    });
  }

  /**
   * Lista vínculos de contatos de um Workspace.
   */
  static async listContactLinks(workspaceId: string, actor: Actor) {
    await AccessService.assertCan(actor, 'manage_crm_links', { workspaceId });

    return prisma.workspaceContactLink.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Remove vínculo de contato.
   */
  static async deleteContactLink(id: string, actor: Actor) {
    const link = await prisma.workspaceContactLink.findUnique({ where: { id } });
    if (!link) throw new NotFoundError('Vínculo de contato não encontrado.');

    await AccessService.assertCan(actor, 'manage_crm_links', { workspaceId: link.workspaceId });

    await prisma.workspaceContactLink.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Configura rota de inbox do CRM para um Workspace (E4.1-a/b).
   */
  static async createInboxRoute(
    workspaceId: string,
    data: CreateInboxRouteInput,
    actor: Actor
  ) {
    await AccessService.assertCan(actor, 'manage_crm_links', { workspaceId });

    if (!data.crmInstanceId?.trim()) throw new ValidationError('crmInstanceId é obrigatório.');
    if (!data.crmInboxId?.trim()) throw new ValidationError('crmInboxId é obrigatório.');

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, isArchived: true, deletedAt: true },
    });

    if (!workspace || workspace.isArchived || workspace.deletedAt) {
      throw new ValidationError('Workspace não encontrado ou inativo.');
    }

    return prisma.workspaceInboxRoute.upsert({
      where: {
        workspaceId_crmInstanceId_crmInboxId: {
          workspaceId,
          crmInstanceId: data.crmInstanceId.trim(),
          crmInboxId: data.crmInboxId.trim(),
        },
      },
      create: {
        workspaceId,
        crmInstanceId: data.crmInstanceId.trim(),
        crmInboxId: data.crmInboxId.trim(),
        inboxName: data.inboxName?.trim() || null,
        isExclusive: data.isExclusive !== false,
        createdByUserId: actor.id,
      },
      update: {
        inboxName: data.inboxName?.trim() || null,
        isExclusive: data.isExclusive !== false,
      },
    });
  }

  /**
   * Lista rotas de inbox de um Workspace.
   */
  static async listInboxRoutes(workspaceId: string, actor: Actor) {
    await AccessService.assertCan(actor, 'manage_crm_links', { workspaceId });

    return prisma.workspaceInboxRoute.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Remove rota de inbox.
   */
  static async deleteInboxRoute(id: string, actor: Actor) {
    const route = await prisma.workspaceInboxRoute.findUnique({ where: { id } });
    if (!route) throw new NotFoundError('Rota de inbox não encontrada.');

    await AccessService.assertCan(actor, 'manage_crm_links', { workspaceId: route.workspaceId });

    await prisma.workspaceInboxRoute.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Fixa o contexto de projeto para uma conversa específica do CRM.
   */
  static async setConversationContext(
    workspaceId: string,
    data: SetConversationContextInput,
    actor: Actor
  ) {
    await AccessService.assertCan(actor, 'manage_crm_links', { workspaceId });

    const project = await prisma.project.findFirst({
      where: { id: data.projectId, workspaceId, isArchived: false, deletedAt: null },
    });

    if (!project) {
      throw new ValidationError('Projeto de destino não encontrado ou inativo no workspace.');
    }

    const expiresAt = data.expiresInHours
      ? new Date(Date.now() + data.expiresInHours * 60 * 60 * 1000)
      : new Date(Date.now() + 24 * 60 * 60 * 1000); // Padrão 24 horas

    return prisma.conversationProjectContext.upsert({
      where: {
        crmInstanceId_crmConversationId: {
          crmInstanceId: data.crmInstanceId.trim(),
          crmConversationId: data.crmConversationId.trim(),
        },
      },
      create: {
        workspaceId,
        projectId: project.id,
        crmInstanceId: data.crmInstanceId.trim(),
        crmConversationId: data.crmConversationId.trim(),
        crmContactId: data.crmContactId?.trim() || null,
        active: true,
        expiresAt,
        createdByUserId: actor.id,
      },
      update: {
        workspaceId,
        projectId: project.id,
        crmContactId: data.crmContactId?.trim() || null,
        active: true,
        expiresAt,
      },
    });
  }

  /**
   * Diagnóstico administrativo de vínculos CRM (E4.1-c):
   * Identifica ambiguidades (contatos vinculados a mais de um workspace ativo),
   * rotas de inboxes compartilhadas e vínculos órfãos com workspaces/projetos arquivados.
   */
  static async getDiagnostics(workspaceId: string, actor: Actor) {
    await AccessService.assertCan(actor, 'manage_crm_links', { workspaceId });

    // 1. Contatos vinculados a este workspace que também têm vínculos em outros workspaces
    const linksInWorkspace = await prisma.workspaceContactLink.findMany({
      where: { workspaceId },
      select: { crmInstanceId: true, crmContactId: true, contactName: true, contactPhone: true },
    });

    const contactIds = linksInWorkspace.map((l) => l.crmContactId);

    const allLinksForTheseContacts = await prisma.workspaceContactLink.findMany({
      where: {
        crmContactId: { in: contactIds },
      },
      include: {
        workspace: { select: { id: true, name: true, isArchived: true } },
      },
    });

    const contactAmbiguities: Array<{
      crmContactId: string;
      contactName?: string | null;
      workspaces: Array<{ id: string; name: string }>;
    }> = [];

    const groupedByContact = new Map<string, Array<{ id: string; name: string }>>();
    for (const l of allLinksForTheseContacts) {
      if (l.workspace.isArchived) continue;
      const arr = groupedByContact.get(l.crmContactId) || [];
      arr.push({ id: l.workspace.id, name: l.workspace.name });
      groupedByContact.set(l.crmContactId, arr);
    }

    for (const [contactId, wsList] of groupedByContact.entries()) {
      if (wsList.length > 1) {
        const item = linksInWorkspace.find((l) => l.crmContactId === contactId);
        contactAmbiguities.push({
          crmContactId: contactId,
          contactName: item?.contactName,
          workspaces: wsList,
        });
      }
    }

    // 2. Inboxes não exclusivas
    const nonExclusiveInboxRoutes = await prisma.workspaceInboxRoute.findMany({
      where: { workspaceId, isExclusive: false },
      select: { id: true, crmInboxId: true, inboxName: true, isExclusive: true },
    });

    // 3. Contextos de conversa expirados ou órfãos
    const invalidContexts = await prisma.conversationProjectContext.findMany({
      where: {
        workspaceId,
        OR: [
          { active: false },
          { expiresAt: { lt: new Date() } },
          { project: { isArchived: true } },
        ],
      },
      include: {
        project: { select: { id: true, name: true, isArchived: true } },
      },
    });

    return {
      contactAmbiguities,
      nonExclusiveInboxRoutes,
      invalidContextsCount: invalidContexts.length,
      invalidContexts,
    };
  }
}
