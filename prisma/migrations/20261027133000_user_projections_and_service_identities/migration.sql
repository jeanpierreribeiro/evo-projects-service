-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "user_projections" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_principals" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_credentials" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_grants" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mode" TEXT NOT NULL DEFAULT 'internal',
    "canShare" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_projections_email_idx" ON "user_projections"("email");

-- CreateIndex
CREATE INDEX "user_projections_isActive_idx" ON "user_projections"("isActive");

-- CreateIndex
CREATE INDEX "service_credentials_principalId_idx" ON "service_credentials"("principalId");

-- CreateIndex
CREATE INDEX "service_credentials_keyPrefix_idx" ON "service_credentials"("keyPrefix");

-- CreateIndex
CREATE INDEX "integration_grants_principalId_idx" ON "integration_grants"("principalId");

-- CreateIndex
CREATE INDEX "integration_grants_workspaceId_idx" ON "integration_grants"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_members_status_idx" ON "workspace_members"("status");

-- AddForeignKey
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "service_principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_grants" ADD CONSTRAINT "integration_grants_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "service_principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_grants" ADD CONSTRAINT "integration_grants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
