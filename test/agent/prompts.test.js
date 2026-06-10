import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTriagePrompt, loadUserPolicy } from "../../src/agent/prompts.js";

describe("agent/prompts user policy (FU-17)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m87-policy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads AGENTS.md from the state dir when present", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Always be terse.\n");
    expect(loadUserPolicy(dir)).toContain("Always be terse.");
  });

  it("returns null when AGENTS.md is absent", () => {
    expect(loadUserPolicy(dir)).toBeNull();
  });

  it("surfaces the user policy in the triage prompt", () => {
    const prompt = buildTriagePrompt({
      item_id: "x",
      user_policy: "Prefer closing duplicates.",
    });
    expect(prompt).toContain("Prefer closing duplicates.");
  });

  it("requires both automation fields and frames kind as a short label", () => {
    const prompt = buildTriagePrompt({ item_id: "x" });
    expect(prompt).toContain("you must fill in both fields");
    expect(prompt).toContain("one to three words");
    expect(prompt).toContain("short user-visible label");
    expect(prompt).toContain(
      "Automation blocks missing either field are discarded",
    );
  });

  it("warns that actions post before the automation runs", () => {
    const prompt = buildTriagePrompt({ item_id: "x" });
    expect(prompt).toContain("execute immediately");
    expect(prompt).toContain("never as completed work");
  });
});
