-- Operra Events OS — Row-Level Security (idempotent; re-run after every migration).
-- Every table with an "organizationId" column is tenant-owned unless listed in the
-- exclusion list below. The runtime role (__APP_ROLE__) is not the table owner and
-- has NOBYPASSRLS, so these policies apply to every application query.

-- Global tables that carry an organizationId only as a lookup pointer.
CREATE OR REPLACE FUNCTION operra_rls_excluded(tbl text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT tbl IN ('PublicToken', 'MessageRef') $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'organizationId' AND t.table_type = 'BASE TABLE'
      AND NOT operra_rls_excluded(c.table_name)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.table_name);
    IF r.table_name = 'Membership' THEN
      -- Users may list their own memberships across tenants (org switcher).
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
        USING ("organizationId" = current_setting('app.org_id', true)
               OR "userId" = current_setting('app.user_id', true))
        WITH CHECK ("organizationId" = current_setting('app.org_id', true))$p$, r.table_name);
    ELSIF r.table_name = 'Role' THEN
      -- Roles attached to the user's own memberships are readable for the org switcher.
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
        USING ("organizationId" = current_setting('app.org_id', true)
               OR id IN (SELECT m."roleId" FROM "Membership" m WHERE m."userId" = current_setting('app.user_id', true)))
        WITH CHECK ("organizationId" = current_setting('app.org_id', true))$p$, r.table_name);
    ELSE
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
        USING ("organizationId" = current_setting('app.org_id', true))
        WITH CHECK ("organizationId" = current_setting('app.org_id', true))$p$, r.table_name);
    END IF;
  END LOOP;
END $$;

-- Organization rows are keyed by "id".
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Organization";
CREATE POLICY tenant_isolation ON "Organization"
  USING (
    id = current_setting('app.org_id', true)
    OR id IN (SELECT m."organizationId" FROM "Membership" m
              WHERE m."userId" = current_setting('app.user_id', true) AND m.status = 'ACTIVE')
  )
  WITH CHECK (id = current_setting('app.org_id', true));

-- Grants for the runtime role.
GRANT USAGE ON SCHEMA public TO __APP_ROLE__;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO __APP_ROLE__;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO __APP_ROLE__;
REVOKE ALL ON TABLE "_prisma_migrations" FROM __APP_ROLE__;
-- Audit trail is append-only for the application.
REVOKE UPDATE, DELETE ON TABLE "AuditEvent" FROM __APP_ROLE__;
