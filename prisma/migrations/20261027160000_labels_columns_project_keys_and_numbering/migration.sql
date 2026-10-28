-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_columnId_fkey";

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "backlogColumnId" TEXT,
ADD COLUMN "key" TEXT,
ADD COLUMN "taskCounter" INTEGER NOT NULL DEFAULT 0;

-- Assign unique project keys based on project name or existing counter
UPDATE "projects"
SET "key" = CASE
  WHEN "key" IS NOT NULL AND "key" <> '' THEN "key"
  ELSE UPPER(SUBSTRING(REGEXP_REPLACE("name", '[^a-zA-Z0-9]', '', 'g') FROM 1 FOR 4))
END;

-- Ensure minimum 2 chars and uppercase alphanumeric for key
UPDATE "projects"
SET "key" = CASE
  WHEN LENGTH("key") < 2 THEN 'PRJ'
  ELSE "key"
END;

-- In case of any duplicate keys per workspace, append an integer
WITH numbered_projects AS (
  SELECT "id", "workspaceId", "key",
         ROW_NUMBER() OVER (PARTITION BY "workspaceId", "key" ORDER BY "createdAt" ASC) as rn
  FROM "projects"
)
UPDATE "projects"
SET "key" = SUBSTRING(np."key" FROM 1 FOR 6) || np.rn
FROM numbered_projects np
WHERE "projects"."id" = np."id" AND np.rn > 1;

-- Now set key to NOT NULL and default
ALTER TABLE "projects" ALTER COLUMN "key" SET NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "key" SET DEFAULT 'PROJ';

-- Update taskCounter for each project to match current MAX(taskNumber)
UPDATE "projects" p
SET "taskCounter" = COALESCE((
  SELECT MAX("taskNumber")
  FROM "tasks" t
  WHERE t."projectId" = p."id"
), 0);

-- AlterTable
ALTER TABLE "tasks" ALTER COLUMN "taskNumber" DROP DEFAULT;
DROP SEQUENCE IF EXISTS "tasks_taskNumber_seq";

-- CreateTable
CREATE TABLE "labels" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_labels" (
    "taskId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_labels_pkey" PRIMARY KEY ("taskId","labelId")
);

-- Populate labels and task_labels from existing tasks.tags
DO $$
DECLARE
  rec RECORD;
  tag_text TEXT;
  norm_name TEXT;
  lbl_id TEXT;
BEGIN
  FOR rec IN SELECT "id", "workspaceId", "tags" FROM "tasks" WHERE "tags" IS NOT NULL AND array_length("tags", 1) > 0 LOOP
    FOREACH tag_text IN ARRAY rec."tags" LOOP
      tag_text := TRIM(tag_text);
      norm_name := LOWER(tag_text);
      IF LENGTH(norm_name) > 0 THEN
        SELECT "id" INTO lbl_id FROM "labels" WHERE "workspaceId" = rec."workspaceId" AND "normalizedName" = norm_name;
        IF lbl_id IS NULL THEN
          lbl_id := 'lbl_' || md5(random()::text || clock_timestamp()::text);
          INSERT INTO "labels" ("id", "workspaceId", "name", "normalizedName", "color", "createdAt", "updatedAt")
          VALUES (lbl_id, rec."workspaceId", tag_text, norm_name, '#64748b', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        END IF;
        
        INSERT INTO "task_labels" ("taskId", "labelId", "createdAt")
        VALUES (rec."id", lbl_id, CURRENT_TIMESTAMP)
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- CreateIndex
CREATE INDEX "labels_workspaceId_idx" ON "labels"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "labels_workspaceId_normalizedName_key" ON "labels"("workspaceId", "normalizedName");

-- CreateIndex
CREATE INDEX "task_labels_taskId_idx" ON "task_labels"("taskId");

-- CreateIndex
CREATE INDEX "task_labels_labelId_idx" ON "task_labels"("labelId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspaceId_key_key" ON "projects"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_projectId_taskNumber_key" ON "tasks"("projectId", "taskNumber");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "columns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add CHECK constraints
ALTER TABLE "projects" ADD CONSTRAINT "projects_key_format_check" CHECK ("key" ~ '^[A-Z0-9]{2,10}$');
ALTER TABLE "labels" ADD CONSTRAINT "labels_color_format_check" CHECK ("color" ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$');
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_task_number_positive_check" CHECK ("taskNumber" > 0);
