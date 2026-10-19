import type { Prisma } from "@/generated/prisma/client";
import { assertRuntimeRole, db } from "./client";

export type Tx = Prisma.TransactionClient;

export interface TenantScope {
  orgId: string;
  userId?: string | null;
}

interface TxOptions {
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * The tenant boundary. Opens a transaction and sets `app.org_id` / `app.user_id`
 * with SET LOCAL semantics (`set_config(..., true)`), which the RLS policies in
 * prisma/sql/rls.sql read. The settings vanish when the transaction ends, so a
 * pooled connection can never carry one tenant's context into another request.
 */
export async function withTenant<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  if (!scope.orgId) throw new Error("withTenant requires an orgId");
  await assertRuntimeRole();
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.org_id', ${scope.orgId}, true), set_config('app.user_id', ${scope.userId ?? ""}, true)`;
      return fn(tx);
    },
    { timeout: opts.timeout ?? 20_000, maxWait: 10_000, isolationLevel: opts.isolationLevel },
  );
}

/** User-scoped boundary (no tenant selected): only the user's own memberships/orgs are visible. */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await assertRuntimeRole();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.org_id', '', true), set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
}
