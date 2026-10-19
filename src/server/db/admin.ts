import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Owner connection that bypasses RLS. ONLY for: seeding, platform super-admin
 * module, and test fixtures. Never import from request-handling domain modules.
 */
let admin: PrismaClient | undefined;
export function adminDb(): PrismaClient {
  if (!admin) {
    const connectionString = process.env.MIGRATION_DATABASE_URL;
    if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is not set");
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return admin;
}
