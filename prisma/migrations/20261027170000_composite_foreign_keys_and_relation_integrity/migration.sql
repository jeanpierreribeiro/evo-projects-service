-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_columnId_fkey";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_projectId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "columns_id_projectId_key" ON "columns"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "projects_id_workspaceId_key" ON "projects"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_id_projectId_key" ON "tasks"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_id_workspaceId_key" ON "tasks"("id", "workspaceId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_columnId_projectId_fkey" FOREIGN KEY ("columnId", "projectId") REFERENCES "columns"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add CHECK constraint to disallow self relations
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_not_self_check" CHECK ("taskId" <> "relatedTaskId");
