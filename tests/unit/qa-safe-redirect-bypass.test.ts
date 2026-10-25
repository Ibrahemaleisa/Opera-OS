/**
 * QA gate (Agent 5), F-15 re-verification: post-login `next` must never resolve to another origin.
 * Complements tests/unit/safe-redirect.test.ts with the variants tried while bypassing the fix.
 */
import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/server/request";

const offSite = (v: string | null) => v !== null && (v.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.includes("\\"));

describe("QA F-15: safeNextPath rejects every off-site variant", () => {
  it.each([
    "//evil.example", "///evil.example", "/\\evil.example", "/%5cevil.example", "/%5Cevil.example", "/%2f%2fevil.example", "/%252f%252fevil.example",
    "/\tevil.example", "/%09/evil.example", "/\n/evil.example", "/%0d%0a/evil.example", "https://evil.example", "HTTPS://evil.example", "javascript:alert(1)",
    "data:text/html,x", "evil.example", " /evil", "\\\\evil.example",
  ])("rejects %j (control)", (v) => {
    expect(offSite(safeNextPath(v))).toBe(false);
  });

  // OPEN — Milestone 1 BLOCKER (S2, F-15 bypass): safeNextPath returns the *normalised* pathname, and dot segments
  // collapse into "//host" (a protocol-relative URL). Reproduced end-to-end on :3000 and :3100. Left failing on purpose.
  it.each(["/..//evil.example/phish", "/.//evil.example", "/%2e%2e//evil.example", "/a/..//evil.example", "/o/demo/../..//evil.example"])(
    "a dot-segment path does not normalise into a protocol-relative URL: %j",
    (v) => {
      const r = safeNextPath(v);
      // EXPECTED: null, or a same-origin path that does not start with "//"
      expect(offSite(r), `safeNextPath(${JSON.stringify(v)}) returned ${JSON.stringify(r)}`).toBe(false);
    },
  );

  it("keeps ordinary in-app paths (control)", () => {
    expect(safeNextPath("/o/demo/tasks/abc?x=1")).toBe("/o/demo/tasks/abc?x=1");
  });
});
