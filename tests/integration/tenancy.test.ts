import { describe, expect, it } from "vitest";
import pg from "pg";
import { db } from "@/server/db/client";
import { withTenant, withUser } from "@/server/db/tenant";
import { listUserOrganizations } from "@/server/authz/load-context";
import { createAgency } from "../helpers";

describe("tenant isolation (database-enforced RLS)", () => {
  it("every table with organizationId has RLS enabled, except documented global lookups", async () => {
    const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await client.connect();
    const { rows } = await client.query(`
      SELECT c.relname, c.relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col ON col.table_name = c.relname AND col.table_schema = 'public' AND col.column_name = 'organizationId'
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    await client.end();
    const unprotected = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname).sort();
    expect(unprotected).toEqual(["MessageRef", "PublicToken"]);
    expect(rows.length).toBeGreaterThan(70);
  });

  it("runtime role is not superuser and cannot bypass RLS", async () => {
    const rows = await db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("queries outside the tenant boundary see no tenant rows", async () => {
    await createAgency("Visible Nowhere");
    expect(await db.project.count()).toBe(0);
    expect(await db.organization.count()).toBe(0);
    expect(await db.role.count()).toBe(0);
  });

  it("tenant A cannot read or write tenant B data even without application filters", async () => {
    const a = await createAgency("Agency A");
    const b = await createAgency("Agency B");
    const projectB = await withTenant({ orgId: b.orgId, userId: b.userId }, (tx) =>
      tx.project.create({ data: { organizationId: b.orgId, code: "PRJ-B-1", name: "Secret B project", createdById: b.userId } }),
    );

    await withTenant({ orgId: a.orgId, userId: a.userId }, async (tx) => {
      // no where clause at all — RLS must filter
      const all = await tx.project.findMany();
      expect(all.find((p) => p.id === projectB.id)).toBeUndefined();
      expect(await tx.project.findUnique({ where: { id: projectB.id } })).toBeNull();
      const updated = await tx.project.updateMany({ where: { id: projectB.id }, data: { name: "pwned" } });
      expect(updated.count).toBe(0);
      const deleted = await tx.project.deleteMany({ where: { id: projectB.id } });
      expect(deleted.count).toBe(0);
    });

    // WITH CHECK: cannot insert a row tagged with another tenant's id
    await expect(
      withTenant({ orgId: a.orgId, userId: a.userId }, (tx) =>
        tx.project.create({ data: { organizationId: b.orgId, code: "X", name: "smuggled", createdById: a.userId } }),
      ),
    ).rejects.toThrow();

    const stillB = await withTenant({ orgId: b.orgId }, (tx) => tx.project.findUnique({ where: { id: projectB.id } }));
    expect(stillB?.name).toBe("Secret B project");
  });

  it("tenant context does not leak across pooled connections", async () => {
    const a = await createAgency("Leak A");
    await withTenant({ orgId: a.orgId }, (tx) => tx.project.create({ data: { organizationId: a.orgId, code: "L-1", name: "L", createdById: a.userId } }));
    // many sequential transactions reuse pool connections; after each, setting must be gone
    for (let i = 0; i < 15; i++) {
      await withTenant({ orgId: a.orgId }, (tx) => tx.project.count());
      expect(await db.project.count()).toBe(0);
    }
  });

  it("user-scoped boundary lists only the user's own memberships", async () => {
    const a = await createAgency("User Scope A");
    await createAgency("User Scope B");
    const orgs = await listUserOrganizations(a.userId);
    expect(orgs.map((o) => o.organizationId)).toEqual([a.orgId]);
    const visible = await withUser(a.userId, (tx) => tx.organization.findMany());
    expect(visible.map((o) => o.id)).toEqual([a.orgId]);
  });
});
