-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "DeliveryEvent" ADD COLUMN     "clientMutationId" TEXT;

-- AlterTable
ALTER TABLE "InvitationCampaign" ADD COLUMN     "config" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "Delivery_importBatchId_idx" ON "Delivery"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryEvent_clientMutationId_key" ON "DeliveryEvent"("clientMutationId");

