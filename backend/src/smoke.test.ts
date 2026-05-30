import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("project can run basic assertions", () => {
    expect(1 + 1).toBe(2);
  });
});
