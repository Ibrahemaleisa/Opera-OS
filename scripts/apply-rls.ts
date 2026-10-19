/**
 * Installs row-level security policies and runtime grants (prisma/sql/rls.sql).
 * Runs as the schema owner (MIGRATION_DATABASE_URL). Idempotent.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { appDbUser, migrationDatabaseUrl } from "../src/server/db/urls";

async function main() {
  const url = migrationDatabaseUrl();
  if (!url) throw new Error("MIGRATION_DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set");
  const role = appDbUser();
  const sql = readFileSync(join(process.cwd(), "prisma/sql/rls.sql"), "utf8").replaceAll("__APP_ROLE__", role);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // On managed Postgres without init hooks (e.g. Neon on Vercel), provision the least-privilege
    // runtime role here. The password comes only from the environment.
    if (process.env.APP_DB_PASSWORD) {
      const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
      const pw = (await client.query("SELECT quote_literal($1) AS q", [process.env.APP_DB_PASSWORD])).rows[0].q as string;
      // new roles default to NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE (non-superusers can't spell those out)
      try {
        await client.query(`${exists ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD ${pw}`);
      } catch (e) {
        if (!exists) throw e;
        // role was created by another admin (e.g. a superuser on self-hosted Postgres): keep its password
        console.warn(`Runtime role ${role} exists and is managed elsewhere; password not changed (${(e as Error).message})`);
      }
      const db = (await client.query("SELECT current_database() AS d")).rows[0].d as string;
      await client.query(`GRANT CONNECT ON DATABASE "${db.replace(/"/g, '""')}" TO ${role}`);
    }
    await client.query(sql);
    const attrs = (await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1", [role])).rows[0];
    if (attrs && (attrs.rolsuper || attrs.rolbypassrls)) throw new Error(`Runtime role ${role} can bypass row-level security — fix its attributes before serving traffic`);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
    );
    console.log(`RLS active on ${rows[0].n} tables (runtime role: ${role})`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
