import prisma from '../db/prisma.js';

export interface CrmResolveInput {
  crmInstanceId: string;
  crmContactId?: string | null;
  crmInboxId?: string | null;
  crmConversationId?: string | null;
}

export type CrmResolutionStatus = 'FOUND' | 'NOT_FOUND' | 'AMBIGUOUS';

export interface CrmResolveResult {
  status: CrmResolutionStatus;
  reason?: string;
  destination?: {
    workspaceId: string;
    workspaceName: string;
    projectId?: string;
    projectName?: string;
    resolutionPath: 'CONVERSATION_CONTEXT' | 'CONTACT_LINK' | 'INBOX_ROUTE';
  };
  candidatesCount?: number;
}

/**
 * Algoritmo determinístico de resolução de contexto CRM (E4.2-a / Seção 9.2).
 *
 * Invariante Inviolável DP14:
 * Ambiguidade ou ausência de vínculo NUNCA escreve.
 * O modelo/runtime nunca adivinha ou seleciona por ordem de cadastro.
 */
export async function resolveCrmContext(input: CrmResolveInput): Promise<CrmResolveResult> {
  const instanceId = input.crmInstanceId?.trim();
  if (!instanceId) {
    return {
      status: 'NOT_FOUND',
      reason: 'crmInstanceId é obrigatório para resolução de contexto.',
    };
  }

  const conversationId = input.crmConversationId?.trim();
  const contactId = input.crmContactId?.trim();
  const inboxId = input.crmInboxId?.trim();

  // 1. Precedência 1: Contexto fixado da conversa (ConversationProjectContext)
  if (conversationId) {
    const convContext = await prisma.conversationProjectContext.findUnique({
      where: {
        crmInstanceId_crmConversationId: {
          crmInstanceId: instanceId,
          crmConversationId: conversationId,
        },
      },
      include: {
        workspace: { select: { id: true, name: true, isArchived: true, deletedAt: true } },
        project: { select: { id: true, name: true, isArchived: true, deletedAt: true } },
      },
    });

    if (convContext && convContext.active) {
      const isExpired = convContext.expiresAt && convContext.expiresAt < new Date();
      const wsActive = convContext.workspace && !convContext.workspace.isArchived && !convContext.workspace.deletedAt;
      const projActive = convContext.project && !convContext.project.isArchived && !convContext.project.deletedAt;

      if (!isExpired && wsActive && projActive) {
        return {
          status: 'FOUND',
          destination: {
            workspaceId: convContext.workspace.id,
            workspaceName: convContext.workspace.name,
            projectId: convContext.project.id,
            projectName: convContext.project.name,
            resolutionPath: 'CONVERSATION_CONTEXT',
          },
        };
      }
    }
  }

  // 2. Precedência 2: Vínculos diretos do contato na mesma instância (WorkspaceContactLink)
  if (contactId) {
    const contactLinks = await prisma.workspaceContactLink.findMany({
      where: {
        crmInstanceId: instanceId,
        crmContactId: contactId,
      },
      include: {
        workspace: { select: { id: true, name: true, isArchived: true, deletedAt: true } },
      },
    });

    const activeLinks = contactLinks.filter(
      (l) => l.workspace && !l.workspace.isArchived && !l.workspace.deletedAt
    );

    if (activeLinks.length === 1) {
      return {
        status: 'FOUND',
        destination: {
          workspaceId: activeLinks[0].workspace.id,
          workspaceName: activeLinks[0].workspace.name,
          resolutionPath: 'CONTACT_LINK',
        },
      };
    }

    if (activeLinks.length > 1) {
      return {
        status: 'AMBIGUOUS',
        reason: 'Contato possui vínculos com múltiplos workspaces ativos nesta instância.',
        candidatesCount: activeLinks.length,
      };
    }
  }

  // 3. Precedência 3: Rota da caixa de entrada / canal (WorkspaceInboxRoute)
  if (inboxId) {
    const inboxRoutes = await prisma.workspaceInboxRoute.findMany({
      where: {
        crmInstanceId: instanceId,
        crmInboxId: inboxId,
      },
      include: {
        workspace: { select: { id: true, name: true, isArchived: true, deletedAt: true } },
      },
    });

    const activeRoutes = inboxRoutes.filter(
      (r) => r.workspace && !r.workspace.isArchived && !r.workspace.deletedAt
    );

    if (activeRoutes.length === 1 && activeRoutes[0].isExclusive === true) {
      return {
        status: 'FOUND',
        destination: {
          workspaceId: activeRoutes[0].workspace.id,
          workspaceName: activeRoutes[0].workspace.name,
          resolutionPath: 'INBOX_ROUTE',
        },
      };
    }

    if (activeRoutes.length > 1 || (activeRoutes.length === 1 && !activeRoutes[0].isExclusive)) {
      return {
        status: 'AMBIGUOUS',
        reason: 'Caixa de entrada não é exclusiva de um único workspace.',
        candidatesCount: activeRoutes.length,
      };
    }
  }

  // 4. Sem correspondência válida
  return {
    status: 'NOT_FOUND',
    reason: 'Nenhum vínculo ou rota ativa encontrada para os dados fornecidos do CRM.',
  };
}
