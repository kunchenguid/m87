import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  gracefulStopDaemon,
  isAlive,
  managedServiceExists,
  restartDaemon,
} from "../../src/cli/daemon-lifecycle.js";
import { getServiceLabel, getServicePlan } from "../../src/cli/service.js";

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
    expect(existsSync(join(stateDir, "daemon.pid"))).toBe(false);
  });

  it("refuses to signal a daemon for a different state dir", async () => {
    child = execFile(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
      "daemon",
      "run",
      "--state-token",
      getServiceLabel(join(homeDir, "other-m87")),
    ]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    const result = await gracefulStopDaemon();

    expect(result).toEqual({ status: "not_running" });
    expect(isAlive(child.pid)).toBe(true);
    expect(existsSync(join(stateDir, "daemon.pid"))).toBe(false);
  });

  it("leaves the pidfile when daemon identity is unknown", async () => {
    child = execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    const result = await gracefulStopDaemon({
      confirmDaemonPid: () => "unknown",
    });

    expect(result).toEqual({ status: "not_running" });
    expect(isAlive(child.pid)).toBe(true);
    expect(existsSync(join(stateDir, "daemon.pid"))).toBe(true);
  });

  it("stops a verified daemon process via the signal fallback", async () => {
    child = execFile(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
      "daemon",
      "run",
      "--state-token",
      getServiceLabel(stateDir),
    ]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    const result = await gracefulStopDaemon();

    expect(result).toMatchObject({ status: "stopped", pid: child.pid });
    expect(isAlive(child.pid)).toBe(false);
  });

  it("stops a legacy daemon process without a state token", async () => {
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

// A service-managed daemon is respawned by its manager whenever it exits, so
// restartDaemon must bounce it through the manager instead of spawning a
// detached daemon that would race the manager's respawn.
describe("cli/daemon-lifecycle restartDaemon with a managed service", () => {
  let homeDir;
  let stateDir;
  const savedEnv = {};
  const cliEntry = join("fake", "cli.js");

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "m87-restart-"));
    stateDir = join(homeDir, ".m87");
    mkdirSync(stateDir, { recursive: true });
    for (const key of [
      "M87_STATE_DIR",
      "M87_SERVICE_DRY_RUN",
      "HOME",
      "USERPROFILE",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.M87_STATE_DIR = stateDir;
    process.env.M87_SERVICE_DRY_RUN = "1";
    // The launchd/systemd unit path hangs off the home dir; point it at the
    // sandbox so the test never touches the real LaunchAgents dir.
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("restarts through the service manager when a unit exists", async () => {
    const plan = getServicePlan(stateDir, cliEntry);
    mkdirSync(dirname(plan.unitPath), { recursive: true });
    writeFileSync(plan.unitPath, plan.content);
    expect(managedServiceExists(cliEntry)).toBe(true);

    const result = await restartDaemon(cliEntry);

    expect(result).toEqual({
      status: "restarted",
      manager: plan.manager,
      unit: plan.unitPath,
      stopped: null,
    });
    // No detached session daemon was spawned behind the manager's back.
    expect(existsSync(join(stateDir, "daemon.pid"))).toBe(false);
  });

  it("reports no managed service when no unit exists", () => {
    expect(managedServiceExists(cliEntry)).toBe(false);
  });
});
