import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/server/request";

describe("safeNextPath (post-login redirect)", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/o/demo/projects?tab=1#x")).toBe("/o/demo/projects?tab=1#x");
    expect(safeNextPath("/portal/demo")).toBe("/portal/demo");
  });
  it.each(["//evil.example", "/\\evil.example/phish", "/%5Cevil.example", "/%2F%2Fevil.example", "https://evil.example", "javascript:alert(1)", "evil", "/\tevil", "%2F%2Fevil.example", "/%255Cevil.example", ""])("rejects %s", (v) => {
    expect(safeNextPath(v)).toBeNull();
  });
});
