import "dotenv/config";
import { defineConfig } from "prisma/config";

// Migrations run as the schema owner. The application runtime uses DATABASE_URL
// (a NOBYPASSRLS role) — see src/server/db/client.ts and SECURITY.md.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? "postgresql://operra:operra_dev@localhost:5432/operra",
  },
});
