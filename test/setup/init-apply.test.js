import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn(() => ({
  pid: 12345,
  unref: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawn,
}));

const { startDetachedDaemon } = await import("../../src/setup/init-apply.js");

describe("init apply daemon startup", () => {
  let homeDir;
  let stateDir;
  let originalStateDir;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "firstpass-init-apply-"));
    stateDir = join(homeDir, ".firstpass");
    mkdirSync(stateDir, { recursive: true });
    originalStateDir = process.env.FIRSTPASS_STATE_DIR;
    process.env.FIRSTPASS_STATE_DIR = stateDir;
    spawn.mockClear();
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.FIRSTPASS_STATE_DIR;
    } else {
      process.env.FIRSTPASS_STATE_DIR = originalStateDir;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("does not spawn another daemon when a live pid is recorded", () => {
    writeFileSync(join(stateDir, "daemon.pid"), String(process.pid));

    const result = startDetachedDaemon("firstpass-cli.js");

    expect(result).toEqual({ status: "already_running", pid: process.pid });
    expect(spawn).not.toHaveBeenCalled();
  });
});
