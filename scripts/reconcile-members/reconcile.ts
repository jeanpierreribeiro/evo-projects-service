import prisma from '../../src/db/prisma.js';

interface ReconcileResult {
  totalScanned: number;
  reconciled: number;
  pendingReview: number;
  unresolvedEmails: string[];
}

/**
 * Script de Reconciliação de Membros e Identidades Legadas (E1.6-f)
 * Suporta --dry-run (padrão) e --apply.
 */
export async function reconcileLegacyMembers(dryRun = true): Promise<ReconcileResult> {
  console.log(`\n=== INICIANDO RECONCILIAÇÃO DE MEMBROS LEGADOS (${dryRun ? 'MODO DRY-RUN' : 'MODO APLICAR'}) ===\n`);

  const members = await prisma.workspaceMember.findMany();
  let reconciled = 0;
  let pendingReview = 0;
  const unresolvedEmails: string[] = [];

  for (const member of members) {
    const isEmailAsUserId = member.userId.includes('@');
    const isLegacyBypassId = member.userId === 'default-operator-id' || member.userId === 'user-default';

    if (!isEmailAsUserId && !isLegacyBypassId) {
      console.log(`[OK] Membro ${member.email} já possui ID canônico: ${member.userId}`);
      continue;
    }

    console.log(`[RECONCILIAR] Encontrado membro legado: Workspace ${member.workspaceId} | Email ${member.email} | userId atual "${member.userId}"`);

    // Busca no Auth / Projeção local por correspondência de email
    const projections = await prisma.userProjection.findMany({
      where: { email: member.email.toLowerCase().trim() },
    });

    if (projections.length === 1) {
      const canonicalUser = projections[0];
      console.log(`  -> Correspondência única encontrada no Auth: ${canonicalUser.id} (${canonicalUser.name})`);

      if (!dryRun) {
        // Atualiza o membro com o ID canônico
        await prisma.workspaceMember.update({
          where: { id: member.id },
          data: {
            userId: canonicalUser.id,
            status: 'ACTIVE',
          },
        });

        // Atualiza atribuições de tarefas legadas
        await prisma.task.updateMany({
          where: { assigneeId: member.userId },
          data: { assigneeId: canonicalUser.id },
        });

        // Atualiza apontamentos de tempo legados
        await prisma.timeEntry.updateMany({
          where: { userId: member.userId },
          data: { userId: canonicalUser.id },
        });

        // Atualiza comentários legados
        await prisma.comment.updateMany({
          where: { userId: member.userId },
          data: { userId: canonicalUser.id },
        });

        console.log(`  -> [APLICADO] Atualizado com sucesso para ${canonicalUser.id}`);
      } else {
        console.log(`  -> [DRY-RUN] Seria atualizado para ${canonicalUser.id}`);
      }
      reconciled++;
    } else if (projections.length > 1) {
      console.warn(`  -> [AMBÍGUO] Múltiplos usuários encontrados com o email ${member.email}. Deixando PENDING.`);
      if (!dryRun) {
        await prisma.workspaceMember.update({
          where: { id: member.id },
          data: { status: 'PENDING' },
        });
      }
      pendingReview++;
      unresolvedEmails.push(member.email);
    } else {
      console.warn(`  -> [NÃO ENCONTRADO] Nenhum usuário com o email ${member.email} encontrado no Auth. Deixando PENDING.`);
      if (!dryRun) {
        await prisma.workspaceMember.update({
          where: { id: member.id },
          data: { status: 'PENDING' },
        });
      }
      pendingReview++;
      unresolvedEmails.push(member.email);
    }
  }

  const result: ReconcileResult = {
    totalScanned: members.length,
    reconciled,
    pendingReview,
    unresolvedEmails,
  };

  console.log(`\n=== RELATÓRIO DE RECONCILIAÇÃO ===`);
  console.log(`Total escaneado: ${result.totalScanned}`);
  console.log(`Reconciliados: ${result.reconciled}`);
  console.log(`Pendências para revisão manual: ${result.pendingReview}`);
  if (result.unresolvedEmails.length > 0) {
    console.log(`Emails com pendência: ${result.unresolvedEmails.join(', ')}`);
  }
  console.log(`==================================\n`);

  return result;
}

// Execução via linha de comando
const isMain = process.argv[1]?.includes('reconcile.ts') || process.argv[1]?.includes('reconcile.js');
if (isMain) {
  const isApply = process.argv.includes('--apply');
  reconcileLegacyMembers(!isApply)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Erro na reconciliação:', err);
      process.exit(1);
    });
}
