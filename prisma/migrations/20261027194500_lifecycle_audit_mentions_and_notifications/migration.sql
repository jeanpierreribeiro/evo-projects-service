-- DropForeignKey
ALTER TABLE "activities" DROP CONSTRAINT "activities_projectId_fkey";

-- DropForeignKey
ALTER TABLE "activities" DROP CONSTRAINT "activities_taskId_fkey";

-- DropForeignKey
ALTER TABLE "activities" DROP CONSTRAINT "activities_workspaceId_fkey";

-- DropIndex
DROP INDEX "notifications_workspaceId_userId_isRead_idx";

-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "actorId" TEXT NOT NULL DEFAULT 'system',
ADD COLUMN     "actorType" TEXT NOT NULL DEFAULT 'USER',
ADD COLUMN     "initiatedByUserId" TEXT,
ADD COLUMN     "requestId" TEXT,
ALTER COLUMN "workspaceId" DROP NOT NULL,
ALTER COLUMN "userId" DROP NOT NULL;

-- Backfill actorId from userId where userId is present
UPDATE "activities" SET "actorId" = "userId" WHERE "userId" IS NOT NULL;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "dedupKey" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionReason" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionReason" TEXT;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionReason" TEXT,
ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "comment_mentions" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comment_mentions_userId_idx" ON "comment_mentions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "comment_mentions_commentId_userId_key" ON "comment_mentions"("commentId", "userId");

-- CreateIndex
CREATE INDEX "activities_projectId_idx" ON "activities"("projectId");

-- CreateIndex
CREATE INDEX "activities_actorId_idx" ON "activities"("actorId");

-- CreateIndex
CREATE INDEX "notifications_workspaceId_userId_isRead_archivedAt_idx" ON "notifications"("workspaceId", "userId", "isRead", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_workspaceId_userId_dedupKey_key" ON "notifications"("workspaceId", "userId", "dedupKey");

-- AddForeignKey
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
