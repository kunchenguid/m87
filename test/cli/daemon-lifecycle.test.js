import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gracefulStopDaemon, isAlive } from "../../src/cli/daemon-lifecycle.js";

// The signal fallback in gracefulStopDaemon acts on a pid read from the pid
// file. That pid can be stale - the daemon died and the OS recycled the pid
// into an unrelated process - so the fallback must verify the live process
// actually looks like `m87 daemon run` before signalling it. These tests run
// the real command-line probe against real disposable processes.
describe("cli/daemon-lifecycle signal fallback identity check", () => {
  let homeDir;
  let stateDir;
  let savedStateDir;
  let child;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "m87-lifecycle-"));
    stateDir = join(homeDir, ".m87");
    mkdirSync(stateDir, { recursive: true });
    savedStateDir = process.env.M87_STATE_DIR;
    process.env.M87_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (savedStateDir === undefined) {
      delete process.env.M87_STATE_DIR;
    } else {
      process.env.M87_STATE_DIR = savedStateDir;
    }
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGKILL");
    }
    child = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("refuses to signal a live process that is not a daemon", async () => {
    // A recycled-pid stand-in: alive, but nothing in its command line says
    // `daemon run`.
    child = execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    const result = await gracefulStopDaemon();

    expect(result).toEqual({ status: "not_running" });
    expect(isAlive(child.pid)).toBe(true);
  });

  it("stops a verified daemon process via the signal fallback", async () => {
    // Extra argv after the -e script makes the command line read `... daemon
    // run`, which is exactly what the identity probe looks for.
    child = execFile(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
      "daemon",
      "run",
    ]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    const result = await gracefulStopDaemon();

    expect(result).toMatchObject({ status: "stopped", pid: child.pid });
    expect(isAlive(child.pid)).toBe(false);
  });
});
