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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the mock factory below can run when the static
// node:child_process import is evaluated.
const spawn = vi.hoisted(() =>
  vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
  })),
);
const execFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  execFileSync,
  spawn,
}));

const { applyInitPlan } = await import("../../src/setup/init-apply.js");
const { installManagedService, startDetachedDaemon } =
  await import("../../src/cli/daemon-lifecycle.js");
const { buildInitApplyPlan, defaultInitSelections } =
  await import("../../src/setup/init-model.js");
const { getServicePlan } = await import("../../src/cli/service.js");

describe("init apply daemon lifecycle", () => {
  let homeDir;
  let stateDir;
  let savedEnv;

  const cliEntry = "m87-cli.js";
  const apply = (selections, context = {}) =>
    applyInitPlan(buildInitApplyPlan(selections, context), {
      bundledPluginPaths: {},
      cliEntry,
    });

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "m87-init-apply-"));
    stateDir = join(homeDir, ".m87");
    mkdirSync(stateDir, { recursive: true });
    savedEnv = {
      M87_STATE_DIR: process.env.M87_STATE_DIR,
      HOME: process.env.HOME,
      M87_SERVICE_DRY_RUN: process.env.M87_SERVICE_DRY_RUN,
    };
    process.env.M87_STATE_DIR = stateDir;
    // Keep service unit files inside the sandbox and skip launchctl/systemctl.
    process.env.HOME = homeDir;
    process.env.M87_SERVICE_DRY_RUN = "1";
    spawn.mockClear();
    execFileSync.mockReset();
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

  it("does not spawn another daemon when a live pid is recorded", () => {
    writeFileSync(join(stateDir, "daemon.pid"), String(process.pid));

    const result = startDetachedDaemon(cliEntry);

    expect(result).toEqual({ status: "already_running", pid: process.pid });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops a session daemon before handing over to the managed service", async () => {
    // A real disposable process stands in for a previously started session
    // daemon (spawn is mocked, execFile is not).
    const child = execFile(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    try {
      const result = await apply(defaultInitSelections());

      expect(result.daemon).toMatchObject({
        status: "stopped",
        pid: child.pid,
      });
      expect(result.service.status).toBe("installed");
      expect(existsSync(getServicePlan(stateDir, cliEntry).unitPath)).toBe(
        true,
      );
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });

  it("does not install the managed service when handover stop fails", async () => {
    const servicePlan = getServicePlan(stateDir, cliEntry);
    const realKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 4242) return true;
      return realKill(pid, signal);
    });
    writeFileSync(join(stateDir, "daemon.pid"), "4242");
    vi.useFakeTimers();

    try {
      const resultPromise = installManagedService(cliEntry);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({
        status: "stop_failed",
        manager: servicePlan.manager,
        label: servicePlan.label,
        unit: servicePlan.unitPath,
        stopped: { status: "stopping", pid: 4242 },
      });
      expect(existsSync(servicePlan.unitPath)).toBe(false);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
    }
  });

  it("reports init failure when service handover stop fails", async () => {
    const servicePlan = getServicePlan(stateDir, cliEntry);
    const realKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 4242) return true;
      return realKill(pid, signal);
    });
    writeFileSync(join(stateDir, "daemon.pid"), "4242");
    vi.useFakeTimers();

    try {
      const resultPromise = apply(defaultInitSelections());
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.status).toBe("stop_failed");
      expect(result.daemon).toEqual({ status: "stopping", pid: 4242 });
      expect(result.service).toEqual({
        status: "stop_failed",
        manager: servicePlan.manager,
        label: servicePlan.label,
        unit: servicePlan.unitPath,
      });
      expect(existsSync(servicePlan.unitPath)).toBe(false);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
    }
  });

  it("stops an already service-managed daemon on reinstall", async () => {
    const servicePlan = getServicePlan(stateDir, cliEntry);
    mkdirSync(dirname(servicePlan.unitPath), { recursive: true });
    writeFileSync(servicePlan.unitPath, "existing unit");
    const child = execFile(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    try {
      const result = await apply(defaultInitSelections());

      expect(result.daemon).toMatchObject({
        status: "stopped",
        pid: child.pid,
      });
      expect(result.service.status).toBe("installed");
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });

  it("reports not_running when stopping with no daemon up", async () => {
    const result = await apply(
      {
        ...defaultInitSelections(),
        installService: false,
        startDaemon: false,
        stopDaemon: true,
      },
      { daemonPid: 4242 },
    );

    expect(result.daemon).toEqual({ status: "not_running" });
  });

  it("uninstalls the managed service and keeps the daemon for session-only", async () => {
    const servicePlan = getServicePlan(stateDir, cliEntry);
    mkdirSync(dirname(servicePlan.unitPath), { recursive: true });
    writeFileSync(servicePlan.unitPath, "existing unit");
    const child = execFile(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    try {
      const result = await apply(
        {
          ...defaultInitSelections(),
          installService: false,
          uninstallService: true,
          startDaemon: true,
        },
        { daemonPid: child.pid, serviceInstalled: true },
      );

      expect(result.service_uninstall).toMatchObject({
        status: "uninstalled",
        manager: servicePlan.manager,
        label: servicePlan.label,
        unit: servicePlan.unitPath,
      });
      expect(existsSync(servicePlan.unitPath)).toBe(false);
      expect(result.daemon).toEqual({
        status: "already_running",
        pid: child.pid,
      });
      expect(child.exitCode).toBe(null);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });

  it("uninstalls the managed service before stopping", async () => {
    const servicePlan = getServicePlan(stateDir, cliEntry);
    mkdirSync(dirname(servicePlan.unitPath), { recursive: true });
    writeFileSync(servicePlan.unitPath, "existing unit");
    const child = execFile(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

    try {
      const result = await apply(
        {
          ...defaultInitSelections(),
          installService: false,
          uninstallService: true,
          startDaemon: false,
          stopDaemon: true,
        },
        { daemonPid: child.pid, serviceInstalled: true },
      );

      expect(result.service_uninstall.status).toBe("uninstalled");
      expect(existsSync(servicePlan.unitPath)).toBe(false);
      expect(result.daemon).toMatchObject({
        status: "stopped",
        pid: child.pid,
      });
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });

  it("does not start a daemon when service deactivation fails", async () => {
    const servicePlan = getServicePlan(stateDir, cliEntry);
    mkdirSync(dirname(servicePlan.unitPath), { recursive: true });
    writeFileSync(servicePlan.unitPath, "existing unit");
    process.env.M87_SERVICE_DRY_RUN = "0";
    execFileSync.mockImplementation(() => {
      throw new Error("deactivate failed");
    });

    const result = await apply(
      {
        ...defaultInitSelections(),
        installService: false,
        uninstallService: true,
        startDaemon: true,
      },
      { serviceInstalled: true },
    );

    expect(result.status).toBe("deactivate_failed");
    expect(result.service_uninstall).toMatchObject({
      status: "uninstalled",
      manager: servicePlan.manager,
      label: servicePlan.label,
      unit: servicePlan.unitPath,
      deactivation: "deactivate_failed",
    });
    expect(result.daemon).toEqual({ status: "not_started" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not stop the daemon when service deactivation fails", async () => {
    const servicePlan = getServicePlan(stateDir, cliEntry);
    mkdirSync(dirname(servicePlan.unitPath), { recursive: true });
    writeFileSync(servicePlan.unitPath, "existing unit");
    const child = execFile(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));
    process.env.M87_SERVICE_DRY_RUN = "0";
    execFileSync.mockImplementation(() => {
      throw new Error("deactivate failed");
    });

    try {
      const result = await apply(
        {
          ...defaultInitSelections(),
          installService: false,
          uninstallService: true,
          startDaemon: false,
          stopDaemon: true,
        },
        { daemonPid: child.pid, serviceInstalled: true },
      );

      expect(result.status).toBe("deactivate_failed");
      expect(result.service_uninstall.deactivation).toBe("deactivate_failed");
      expect(result.daemon).toEqual({ status: "not_started" });
      expect(process.kill(child.pid, 0)).toBe(true);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });
});
