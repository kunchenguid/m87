import { describe, expect, it } from "vitest";

import { hasUsableAutomation } from "../../src/cli/index.js";

describe("cli/hasUsableAutomation", () => {
  it("requires both kind and prompt", () => {
    expect(hasUsableAutomation(null)).toBe(false);
    expect(hasUsableAutomation("{}")).toBe(false);
    expect(hasUsableAutomation(JSON.stringify({ prompt: "fix it" }))).toBe(
      false,
    );
    expect(hasUsableAutomation(JSON.stringify({ kind: "code fix" }))).toBe(
      false,
    );
    expect(
      hasUsableAutomation(
        JSON.stringify({ kind: "code fix", prompt: "fix it" }),
      ),
    ).toBe(true);
  });
});
