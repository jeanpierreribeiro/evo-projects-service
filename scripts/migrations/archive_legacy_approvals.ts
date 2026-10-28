import prisma from '../../src/db/prisma.js';
import crypto from 'crypto';

function sha256(val: string | null): string | null {
  if (!val) return null;
  return crypto.createHash('sha256').update(val).digest('hex');
}

export async function archiveLegacyApprovals() {
  console.log('--- Iniciando arquivamento e revogação de aprovações legadas (E1.2-h) ---');

  const tasksWithLegacy = await prisma.task.findMany({
    where: {
      OR: [
        { approvalToken: { not: null } },
        { approvalPin: { not: null } },
        { approvalStatus: { not: 'NONE' } },
      ],
    },
  });

  console.log(`Encontradas ${tasksWithLegacy.length} tarefas com dados legados de aprovação.`);

  let archivedCount = 0;
  for (const t of tasksWithLegacy) {
    const tokenHash = sha256(t.approvalToken);
    const pinHash = sha256(t.approvalPin);

    // Upsert idempotente no arquivo histórico
    await prisma.legacyTaskApprovalArchive.upsert({
      where: { taskId: t.id },
      create: {
        taskId: t.id,
        taskNumber: t.taskNumber,
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        approvalStatus: t.approvalStatus,
        tokenHash,
        pinHash,
        feedback: t.approvalFeedback,
        approvedAt: t.approvedAt,
        approvedIp: t.approvedIp,
      },
      update: {
        approvalStatus: t.approvalStatus,
        tokenHash,
        pinHash,
        feedback: t.approvalFeedback,
        approvedAt: t.approvedAt,
        approvedIp: t.approvedIp,
      },
    });

    // Revoga e zera os segredos na tarefa ativa
    await prisma.task.update({
      where: { id: t.id },
      data: {
        approvalToken: null,
        approvalPin: null,
        approvalFeedback: null,
      },
    });

    archivedCount++;
  }

  console.log(`✅ Arquivamento concluído com sucesso. Total arquivado e revogado: ${archivedCount}`);
  return archivedCount;
}

if (process.argv[1]?.endsWith('archive_legacy_approvals.ts') || process.argv[1]?.endsWith('archive_legacy_approvals.js')) {
  archiveLegacyApprovals()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Erro no arquivamento legado:', err);
      process.exit(1);
    });
}
