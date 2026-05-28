import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (
    await importOriginal()
  );
  return { ...actual, execFileSync: vi.fn() };
});

import { killChild } from "./e2e-harness.js";

const originalPlatform = process.platform;

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

describe("e2e harness process cleanup", () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    vi.clearAllMocks();
  });

  it("kills a Windows child process tree with taskkill", () => {
    setPlatform("win32");

    killChild({ pid: 1234, kill: vi.fn() });

    expect(execFileSync).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "1234", "/t", "/f"],
      { stdio: "ignore" },
    );
  });
});
