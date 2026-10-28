-- CreateTable
CREATE TABLE "task_shares" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "createdByActorType" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "initiatedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByActor" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "showDescription" BOOLEAN NOT NULL DEFAULT true,
    "showSubtasks" BOOLEAN NOT NULL DEFAULT true,
    "showResources" BOOLEAN NOT NULL DEFAULT true,
    "publicContentUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_shares_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_shares_expires_after_created_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateTable
CREATE TABLE "task_share_resources" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_share_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_share_sessions" (
    "id" TEXT NOT NULL,
    "sessionTokenHash" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_share_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_share_sessions_expires_after_created_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseJson" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_records_expires_after_created_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_shares_tokenHash_key" ON "task_shares"("tokenHash");

-- CreateIndex
CREATE INDEX "task_shares_workspaceId_idx" ON "task_shares"("workspaceId");

-- CreateIndex
CREATE INDEX "task_shares_taskId_idx" ON "task_shares"("taskId");

-- CreateIndex
CREATE INDEX "task_shares_expiresAt_idx" ON "task_shares"("expiresAt");

-- CreateIndex
CREATE INDEX "task_shares_createdById_idx" ON "task_shares"("createdById");

-- CreateIndex
CREATE INDEX "task_share_resources_shareId_idx" ON "task_share_resources"("shareId");

-- CreateIndex
CREATE INDEX "task_share_resources_resourceId_idx" ON "task_share_resources"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "task_share_resources_shareId_resourceId_key" ON "task_share_resources"("shareId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "task_share_sessions_sessionTokenHash_key" ON "task_share_sessions"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "task_share_sessions_shareId_idx" ON "task_share_sessions"("shareId");

-- CreateIndex
CREATE INDEX "task_share_sessions_expiresAt_idx" ON "task_share_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scopeKey_key" ON "idempotency_records"("scopeKey");

-- AddForeignKey
ALTER TABLE "task_shares" ADD CONSTRAINT "task_shares_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_shares" ADD CONSTRAINT "task_shares_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_share_resources" ADD CONSTRAINT "task_share_resources_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "task_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_share_resources" ADD CONSTRAINT "task_share_resources_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "task_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_share_sessions" ADD CONSTRAINT "task_share_sessions_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "task_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;
