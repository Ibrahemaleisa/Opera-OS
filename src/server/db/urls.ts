/**
 * Connection-string resolution shared by the app and the maintenance scripts (relative-import safe).
 *
 * Self-hosted: DATABASE_URL = runtime role (NOBYPASSRLS), MIGRATION_DATABASE_URL = owner.
 * Vercel + Neon: the integration injects DATABASE_URL / DATABASE_URL_UNPOOLED for the *owner*
 * role, which bypasses RLS. There the runtime connects as APP_DB_USER (default operra_app)
 * with APP_DB_PASSWORD on the pooled host, and migrations use the unpooled owner URL.
 */
export function migrationDatabaseUrl(env = process.env): string | undefined {
  return env.MIGRATION_DATABASE_URL || env.DATABASE_URL_UNPOOLED || undefined;
}

export function runtimeDatabaseUrl(env = process.env): string | undefined {
  if (env.APP_DATABASE_URL) return env.APP_DATABASE_URL;
  const base = env.DATABASE_URL;
  if (!base || !env.APP_DB_PASSWORD) return base;
  const u = new URL(base);
  u.username = appDbUser(env);
  u.password = env.APP_DB_PASSWORD;
  return u.toString();
}

export function appDbUser(env = process.env): string {
  // default role name: legacy identifier, kept so existing deployments and devices keep working (ARCHITECTURE.md §10)
  const role = env.APP_DB_USER || env.DATABASE_APP_ROLE || "operra_app";
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`Invalid database role name: ${role}`);
  return role;
}
