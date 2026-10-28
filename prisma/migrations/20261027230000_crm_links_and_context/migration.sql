-- CreateTable
CREATE TABLE "workspace_contact_links" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "crmInstanceId" TEXT NOT NULL,
    "crmContactId" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_contact_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_inbox_routes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "crmInstanceId" TEXT NOT NULL,
    "crmInboxId" TEXT NOT NULL,
    "inboxName" TEXT,
    "isExclusive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_inbox_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_project_contexts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "crmInstanceId" TEXT NOT NULL,
    "crmConversationId" TEXT NOT NULL,
    "crmContactId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_project_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_crm_links" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "crmInstanceId" TEXT NOT NULL,
    "crmContactId" TEXT NOT NULL,
    "crmConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_crm_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_contact_links_crmInstanceId_crmContactId_idx" ON "workspace_contact_links"("crmInstanceId", "crmContactId");

-- CreateIndex
CREATE INDEX "workspace_contact_links_workspaceId_idx" ON "workspace_contact_links"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_contact_links_workspaceId_crmInstanceId_crmContac_key" ON "workspace_contact_links"("workspaceId", "crmInstanceId", "crmContactId");

-- CreateIndex
CREATE INDEX "workspace_inbox_routes_crmInstanceId_crmInboxId_idx" ON "workspace_inbox_routes"("crmInstanceId", "crmInboxId");

-- CreateIndex
CREATE INDEX "workspace_inbox_routes_workspaceId_idx" ON "workspace_inbox_routes"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_inbox_routes_workspaceId_crmInstanceId_crmInboxId_key" ON "workspace_inbox_routes"("workspaceId", "crmInstanceId", "crmInboxId");

-- CreateIndex
CREATE INDEX "conversation_project_contexts_workspaceId_idx" ON "conversation_project_contexts"("workspaceId");

-- CreateIndex
CREATE INDEX "conversation_project_contexts_projectId_idx" ON "conversation_project_contexts"("projectId");

-- CreateIndex
CREATE INDEX "conversation_project_contexts_crmInstanceId_crmConversation_idx" ON "conversation_project_contexts"("crmInstanceId", "crmConversationId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_project_contexts_crmInstanceId_crmConversation_key" ON "conversation_project_contexts"("crmInstanceId", "crmConversationId");

-- CreateIndex
CREATE UNIQUE INDEX "task_crm_links_taskId_key" ON "task_crm_links"("taskId");

-- CreateIndex
CREATE INDEX "task_crm_links_crmInstanceId_crmContactId_idx" ON "task_crm_links"("crmInstanceId", "crmContactId");

-- CreateIndex
CREATE INDEX "task_crm_links_crmInstanceId_crmConversationId_idx" ON "task_crm_links"("crmInstanceId", "crmConversationId");

-- AddForeignKey
ALTER TABLE "workspace_contact_links" ADD CONSTRAINT "workspace_contact_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_inbox_routes" ADD CONSTRAINT "workspace_inbox_routes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_project_contexts" ADD CONSTRAINT "conversation_project_contexts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_project_contexts" ADD CONSTRAINT "conversation_project_contexts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_crm_links" ADD CONSTRAINT "task_crm_links_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
