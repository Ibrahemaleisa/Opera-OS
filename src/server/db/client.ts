import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { runtimeDatabaseUrl } from "./urls";

/**
 * Runtime Prisma client. Connects as the NOBYPASSRLS application role, so any
 * query against a tenant table outside `withTenant` returns no rows.
 * Use it directly ONLY for global tables (User, Session, PublicToken, MessageRef, Permission).
 */
const globalForDb = globalThis as unknown as { __operaDb?: PrismaClient };

function createClient() {
  const connectionString = runtimeDatabaseUrl();
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export const db: PrismaClient = globalForDb.__operaDb ?? createClient();
if (process.env.NODE_ENV !== "production") globalForDb.__operaDb = db;

export type Db = PrismaClient;

let roleCheck: Promise<void> | undefined;
/**
 * Fails closed in production if the runtime connection could bypass row-level security
 * (superuser, BYPASSRLS, or the table owner) — e.g. a provider-injected owner URL.
 */
export function assertRuntimeRole(): Promise<void> {
  if (process.env.NODE_ENV !== "production" || process.env.ALLOW_RLS_BYPASS_ROLE === "true") return Promise.resolve();
  return (roleCheck ??= (async () => {
    const [r] = await db.$queryRaw<{ unsafe: boolean; role: string }[]>`
      SELECT (r.rolsuper OR r.rolbypassrls OR EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = 'Organization' AND t.tableowner = current_user)) AS unsafe, current_user AS role
      FROM pg_roles r WHERE r.rolname = current_user`;
    if (r?.unsafe) {
      roleCheck = undefined;
      throw new Error(`Refusing to serve: database role "${r.role}" bypasses row-level security. Set APP_DB_PASSWORD (and run migrations) or APP_DATABASE_URL to a NOBYPASSRLS role.`);
    }
  })());
}
