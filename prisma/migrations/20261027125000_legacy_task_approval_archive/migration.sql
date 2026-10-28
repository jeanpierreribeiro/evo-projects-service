-- CreateTable
CREATE TABLE "legacy_task_approval_archive" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskNumber" INTEGER NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NONE',
    "tokenHash" TEXT,
    "pinHash" TEXT,
    "feedback" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedIp" TEXT,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_task_approval_archive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legacy_task_approval_archive_taskId_key" ON "legacy_task_approval_archive"("taskId");

-- CreateIndex
CREATE INDEX "legacy_task_approval_archive_workspaceId_idx" ON "legacy_task_approval_archive"("workspaceId");

-- CreateIndex
CREATE INDEX "legacy_task_approval_archive_projectId_idx" ON "legacy_task_approval_archive"("projectId");
