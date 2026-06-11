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

    killChild({ pid: 1234, exitCode: null, signalCode: null, kill: vi.fn() });

    expect(execFileSync).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "1234", "/t", "/f"],
      { stdio: "ignore" },
    );
  });

  // Once the exit is observed the OS may have recycled the pid, so a raw-pid
  // taskkill could hit an unrelated process (the Windows CI plugin-kill flake).
  it("does not taskkill a child whose exit was already observed", () => {
    setPlatform("win32");
    const kill = vi.fn();

    killChild({ pid: 1234, exitCode: 1, signalCode: null, kill });

    expect(execFileSync).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not signal the process group of an exited child on POSIX", () => {
    setPlatform("linux");
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);

    try {
      killChild({
        pid: 1234,
        exitCode: null,
        signalCode: "SIGTERM",
        kill: vi.fn(),
      });

      expect(processKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });
});
