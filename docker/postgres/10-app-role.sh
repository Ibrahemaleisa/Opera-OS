#!/bin/sh
# Creates the least-privilege runtime role used by the application (row-level security applies to it).
# Grants are installed later by `pnpm db:migrate` (scripts/apply-rls.ts).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
    CREATE ROLE ${APP_DB_USER} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
SQL
