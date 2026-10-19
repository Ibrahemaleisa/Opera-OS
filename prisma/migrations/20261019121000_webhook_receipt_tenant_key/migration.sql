-- DropIndex
DROP INDEX "WebhookReceipt_provider_externalId_key";

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_organizationId_provider_externalId_key" ON "WebhookReceipt"("organizationId", "provider", "externalId");

