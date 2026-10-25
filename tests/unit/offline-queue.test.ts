import { describe, expect, it } from "vitest";
import { ownership, partitionQueue, toAttention, toRetry, type QueuedMutation } from "@/lib/offline-store";

const base = (over: Partial<QueuedMutation>): QueuedMutation => ({ clientMutationId: crypto.randomUUID(), orgSlug: "demo", deliveryId: "d1", to: "OUT_FOR_DELIVERY", occurredAt: new Date(0).toISOString(), createdAt: 1, ...over });
const agent1 = { orgSlug: "demo", userId: "u1", userName: "Agent One" };
const agent2 = { orgSlug: "demo", userId: "u2", userName: "Agent Two" };

describe("offline queue is scoped to the signed-in agent", () => {
  it("decides ownership by user id, then by name for entries recorded before ids were known", () => {
    expect(ownership(base({ userId: "u1" }), agent1)).toBe("mine");
    expect(ownership(base({ userId: "u1" }), agent2)).toBe("other");
    expect(ownership(base({ userName: "Agent One" }), agent1)).toBe("mine");
    expect(ownership(base({ userName: "Agent One" }), agent2)).toBe("other");
    expect(ownership(base({ userId: "u1" }), { orgSlug: "other-org", userId: "u1" })).toBe("other");
    expect(ownership(base({}), agent1)).toBe("unknown");
  });

  it("only the agent's own pending items are replayed; another account's stay on the device untouched", () => {
    const mine1 = base({ userId: "u1", createdAt: 2 });
    const mine0 = base({ userId: "u1", createdAt: 1 });
    const theirs = base({ userId: "u2" });
    const otherOrg = base({ orgSlug: "x", userId: "u3" });
    const view = partitionQueue([mine1, theirs, mine0, otherOrg], agent1);
    expect(view.pending.map((m) => m.clientMutationId)).toEqual([mine0.clientMutationId, mine1.clientMutationId]);
    expect(view.attention).toEqual([]);
    expect(view.others).toBe(1);
    const asAgent2 = partitionQueue([mine1, theirs, mine0], agent2);
    expect(asAgent2.pending.map((m) => m.clientMutationId)).toEqual([theirs.clientMutationId]);
    expect(asAgent2.others).toBe(2);
  });

  it("rejected items and legacy entries without an owner are never auto-sent", () => {
    const rejected = toAttention(base({ userId: "u1" }), "rejected", "errors.notFound");
    const legacy = base({});
    const view = partitionQueue([rejected, legacy], agent1);
    expect(view.pending).toEqual([]);
    expect(view.attention).toHaveLength(2);
    expect(view.attention.find((m) => m.clientMutationId === legacy.clientMutationId)?.attentionReason).toBe("unknownOwner");
    expect(view.attention.find((m) => m.clientMutationId === rejected.clientMutationId)?.lastError).toBe("errors.notFound");
  });

  it("retrying a conflict re-owns the item and drops the stale version", () => {
    const conflict = toAttention(base({ userId: "u1", version: 4 }), "conflict", "common.offlineQueue.conflictWith", "FAILED_ATTEMPT");
    const retried = toRetry(conflict, agent1);
    expect(retried.state).toBe("pending");
    expect(retried.version).toBeUndefined();
    expect(retried.conflictStatus).toBeUndefined();
    expect(partitionQueue([retried], agent1).pending).toHaveLength(1);
    const rejected = toRetry(toAttention(base({ userId: "u1", version: 2 }), "rejected", "errors.invalidTransition"), agent1);
    expect(rejected.version).toBe(2);
  });
});
