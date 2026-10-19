import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Runtime Prisma client. Connects as the NOBYPASSRLS application role, so any
 * query against a tenant table outside `withTenant` returns no rows.
 * Use it directly ONLY for global tables (User, Session, PublicToken, MessageRef, Permission).
 */
const globalForDb = globalThis as unknown as { __operraDb?: PrismaClient };

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export const db: PrismaClient = globalForDb.__operraDb ?? createClient();
if (process.env.NODE_ENV !== "production") globalForDb.__operraDb = db;

export type Db = PrismaClient;
