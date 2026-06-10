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

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawn,
}));

const { applyInitPlan } = await import("../../src/setup/init-apply.js");
const { startDetachedDaemon } =
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

  it("leaves an already service-managed daemon running on reinstall", async () => {
    const servicePlan = getServicePlan(stateDir, cliEntry);
    mkdirSync(dirname(servicePlan.unitPath), { recursive: true });
    writeFileSync(servicePlan.unitPath, "existing unit");
    // If apply wrongly tried to stop this "daemon", it would signal the test
    // process itself - a loud failure.
    writeFileSync(join(stateDir, "daemon.pid"), String(process.pid));

    const result = await apply(defaultInitSelections());

    expect(result.daemon).toEqual({ status: "not_started" });
    expect(result.service.status).toBe("installed");
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
});
