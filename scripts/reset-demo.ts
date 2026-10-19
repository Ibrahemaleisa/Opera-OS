/**
 * Development helper: deletes ONE organization (default "demo") and every tenant row it owns,
 * plus users whose only membership was in that organization. Refuses to run in production.
 *
 *   pnpm tsx scripts/reset-demo.ts [slug]
 */
import "dotenv/config";
import pg from "pg";
import { migrationDatabaseUrl } from "../src/server/db/urls";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("refusing to run in production");
  const slug = process.argv[2] ?? "demo";
  const url = migrationDatabaseUrl();
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required (owner role)");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const org = (await c.query(`SELECT id FROM "Organization" WHERE slug = $1`, [slug])).rows[0];
    if (!org) return console.log(`no organization "${slug}"`);
    const users = (await c.query(`SELECT "userId" FROM "Membership" m WHERE m."organizationId" = $1 AND NOT EXISTS (SELECT 1 FROM "Membership" x WHERE x."userId" = m."userId" AND x."organizationId" <> $1)`, [org.id])).rows.map((r) => r.userId);
    const tables = (await c.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organizationId' AND table_name <> 'Organization'`)).rows.map((r) => r.table_name as string);
    await c.query("BEGIN");
    // delete children first; retry tables blocked by foreign keys until everything is gone
    let pending = tables;
    for (let round = 0; pending.length && round < 20; round++) {
      const next: string[] = [];
      for (const t of pending) {
        await c.query("SAVEPOINT s");
        try {
          await c.query(`DELETE FROM "${t}" WHERE "organizationId" = $1`, [org.id]);
          await c.query("RELEASE SAVEPOINT s");
        } catch {
          await c.query("ROLLBACK TO SAVEPOINT s");
          next.push(t);
        }
      }
      pending = next;
    }
    if (pending.length) throw new Error(`could not clear: ${pending.join(", ")}`);
    await c.query(`DELETE FROM "PublicToken" WHERE "organizationId" = $1`, [org.id]).catch(() => undefined);
    await c.query(`DELETE FROM "Organization" WHERE id = $1`, [org.id]);
    if (users.length) {
      await c.query(`DELETE FROM "Session" WHERE "userId" = ANY($1)`, [users]);
      await c.query(`DELETE FROM "User" WHERE id = ANY($1)`, [users]);
    }
    await c.query("COMMIT");
    console.log(`removed organization "${slug}" (${tables.length} tables scanned, ${users.length} users)`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
