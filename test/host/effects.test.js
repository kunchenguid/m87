import { describe, expect, it } from "vitest";

import { normalizeAutomation } from "../../src/host/effects.js";

describe("host/normalizeAutomation", () => {
  it("keeps a block with a non-empty kind and prompt, trimmed", () => {
    expect(
      normalizeAutomation({ kind: " code fix ", prompt: " do the thing " }),
    ).toEqual({ kind: "code fix", prompt: "do the thing" });
  });

  it("drops blocks missing either required field", () => {
    expect(normalizeAutomation(null)).toBeNull();
    expect(normalizeAutomation({})).toBeNull();
    expect(normalizeAutomation({ kind: "code fix" })).toBeNull();
    expect(normalizeAutomation({ prompt: "do the thing" })).toBeNull();
    expect(
      normalizeAutomation({ kind: "  ", prompt: "do the thing" }),
    ).toBeNull();
    expect(normalizeAutomation({ kind: "code fix", prompt: "" })).toBeNull();
    expect(normalizeAutomation({ kind: 1, prompt: "do the thing" })).toBeNull();
  });

  it("strips fields beyond the contract's kind and prompt", () => {
    expect(
      normalizeAutomation({ kind: "recheck", prompt: "p", extra: true }),
    ).toEqual({ kind: "recheck", prompt: "p" });
  });
});
