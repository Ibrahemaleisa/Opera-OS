-- "At risk" is now derived from live data (health v2), not a status a person sets
-- (BUSINESS_RULES.md §1.1 LC-1). Existing AT_RISK projects become ACTIVE, with an audit row each.
INSERT INTO "AuditEvent" ("id", "organizationId", "actorName", "action", "entityType", "entityId", "projectId", "summary", "before", "after", "createdAt")
SELECT 'norm_' || md5(p."id" || 'at_risk'), p."organizationId", 'Opera', 'project.status_normalized', 'PROJECT', p."id", p."id",
       'AT_RISK is derived from health; status set to ACTIVE', '{"status": "AT_RISK"}'::jsonb, '{"status": "ACTIVE"}'::jsonb, CURRENT_TIMESTAMP
FROM "Project" p
WHERE p."status" = 'AT_RISK';

UPDATE "Project" SET "status" = 'ACTIVE' WHERE "status" = 'AT_RISK';
