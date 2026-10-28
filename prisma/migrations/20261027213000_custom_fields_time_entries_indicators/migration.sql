-- AlterTable
ALTER TABLE "custom_fields" ADD COLUMN     "isPublicEligible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
DROP COLUMN "options",
ADD COLUMN     "options" JSONB DEFAULT '[]';

-- AlterTable
ALTER TABLE "task_shares" ADD COLUMN     "showCustomFields" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "task_share_custom_fields" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "customFieldId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_share_custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_share_custom_fields_shareId_idx" ON "task_share_custom_fields"("shareId");

-- CreateIndex
CREATE INDEX "task_share_custom_fields_customFieldId_idx" ON "task_share_custom_fields"("customFieldId");

-- CreateIndex
CREATE UNIQUE INDEX "task_share_custom_fields_shareId_customFieldId_key" ON "task_share_custom_fields"("shareId", "customFieldId");

-- CreateIndex
CREATE INDEX "custom_field_values_fieldId_idx" ON "custom_field_values"("fieldId");

-- AddForeignKey
ALTER TABLE "task_share_custom_fields" ADD CONSTRAINT "task_share_custom_fields_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "task_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_share_custom_fields" ADD CONSTRAINT "task_share_custom_fields_customFieldId_fkey" FOREIGN KEY ("customFieldId") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;
