/**
 * Installs row-level security policies and runtime grants (prisma/sql/rls.sql).
 * Runs as the schema owner (MIGRATION_DATABASE_URL). Idempotent.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set");
  const role = process.env.DATABASE_APP_ROLE ?? "operra_app";
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`Invalid DATABASE_APP_ROLE: ${role}`);
  const sql = readFileSync(join(process.cwd(), "prisma/sql/rls.sql"), "utf8").replaceAll("__APP_ROLE__", role);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
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
