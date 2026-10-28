-- AlterTable: Workspaces timezone
ALTER TABLE "workspaces" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_timezone_not_empty_check" CHECK (length(trim("timezone")) > 0);

-- AlterTable: Tasks civil dates and estimatedMinutes
ALTER TABLE "tasks" DROP COLUMN "estimatedHours",
ADD COLUMN "estimatedMinutes" INTEGER,
ALTER COLUMN "startDate" SET DATA TYPE DATE,
ALTER COLUMN "dueDate" SET DATA TYPE DATE;

-- Constraints: I4 & I6
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_dates_order_check" CHECK ("startDate" IS NULL OR "dueDate" IS NULL OR "startDate" <= "dueDate");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_estimated_minutes_positive_check" CHECK ("estimatedMinutes" IS NULL OR "estimatedMinutes" > 0);

-- Constraints: I6 on time_entries duration
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_duration_positive_check" CHECK ("durationMinutes" > 0);
