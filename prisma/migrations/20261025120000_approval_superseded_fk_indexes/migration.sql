-- AlterEnum
ALTER TYPE "ApprovalStatus" ADD VALUE 'SUPERSEDED';

-- CreateIndex
CREATE INDEX "ApprovalDecision_organizationId_approvalId_idx" ON "ApprovalDecision"("organizationId", "approvalId");

-- CreateIndex
CREATE INDEX "AutomationExecution_organizationId_ruleId_idx" ON "AutomationExecution"("organizationId", "ruleId");

-- CreateIndex
CREATE INDEX "Checklist_organizationId_taskId_idx" ON "Checklist"("organizationId", "taskId");

-- CreateIndex
CREATE INDEX "ChecklistItem_organizationId_checklistId_idx" ON "ChecklistItem"("organizationId", "checklistId");

-- CreateIndex
CREATE INDEX "Comment_organizationId_authorId_idx" ON "Comment"("organizationId", "authorId");

-- CreateIndex
CREATE INDEX "Contact_organizationId_clientId_idx" ON "Contact"("organizationId", "clientId");

-- CreateIndex
CREATE INDEX "Contact_organizationId_vendorId_idx" ON "Contact"("organizationId", "vendorId");

-- CreateIndex
CREATE INDEX "Delivery_organizationId_recipientId_idx" ON "Delivery"("organizationId", "recipientId");

-- CreateIndex
CREATE INDEX "Delivery_organizationId_batchId_idx" ON "Delivery"("organizationId", "batchId");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_organizationId_deliveryId_idx" ON "DeliveryAssignment"("organizationId", "deliveryId");

-- CreateIndex
CREATE INDEX "DeliveryEvidence_organizationId_deliveryId_idx" ON "DeliveryEvidence"("organizationId", "deliveryId");

-- CreateIndex
CREATE INDEX "Inspection_organizationId_boothId_idx" ON "Inspection"("organizationId", "boothId");

-- CreateIndex
CREATE INDEX "Membership_organizationId_roleId_idx" ON "Membership"("organizationId", "roleId");

-- CreateIndex
CREATE INDEX "MessageJob_organizationId_invitationId_idx" ON "MessageJob"("organizationId", "invitationId");

-- CreateIndex
CREATE INDEX "Project_organizationId_clientId_idx" ON "Project"("organizationId", "clientId");

-- CreateIndex
CREATE INDEX "ProjectVenue_organizationId_venueId_idx" ON "ProjectVenue"("organizationId", "venueId");

-- CreateIndex
CREATE INDEX "Quote_organizationId_rfqId_idx" ON "Quote"("organizationId", "rfqId");

-- CreateIndex
CREATE INDEX "Snag_organizationId_boothId_idx" ON "Snag"("organizationId", "boothId");

-- CreateIndex
CREATE INDEX "Task_organizationId_workstreamId_idx" ON "Task"("organizationId", "workstreamId");

-- CreateIndex
CREATE INDEX "Task_organizationId_parentId_idx" ON "Task"("organizationId", "parentId");

-- CreateIndex
CREATE INDEX "TaskAssignmentHistory_organizationId_taskId_idx" ON "TaskAssignmentHistory"("organizationId", "taskId");

-- CreateIndex
CREATE INDEX "TaskDependency_organizationId_dependsOnId_idx" ON "TaskDependency"("organizationId", "dependsOnId");

-- CreateIndex
CREATE INDEX "Team_organizationId_idx" ON "Team"("organizationId");

-- CreateIndex
CREATE INDEX "TemplateInstance_organizationId_templateVersionId_idx" ON "TemplateInstance"("organizationId", "templateVersionId");

-- CreateIndex
CREATE INDEX "Workstream_organizationId_templateInstanceId_idx" ON "Workstream"("organizationId", "templateInstanceId");

