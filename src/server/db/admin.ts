import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { migrationDatabaseUrl } from "./urls";

/**
 * Owner connection that bypasses RLS. ONLY for: seeding, maintenance scripts
 * and test fixtures. Never import from request-handling domain modules.
 */
let admin: PrismaClient | undefined;
export function adminDb(): PrismaClient {
  if (!admin) {
    const connectionString = migrationDatabaseUrl();
    if (!connectionString) throw new Error("MIGRATION_DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set");
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return admin;
}
