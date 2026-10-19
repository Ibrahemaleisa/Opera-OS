-- DropIndex
DROP INDEX "DeliveryAttempt_clientMutationId_key";

-- DropIndex
DROP INDEX "DeliveryEvent_clientMutationId_key";

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_organizationId_clientMutationId_key" ON "DeliveryAttempt"("organizationId", "clientMutationId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryEvent_organizationId_clientMutationId_key" ON "DeliveryEvent"("organizationId", "clientMutationId");

