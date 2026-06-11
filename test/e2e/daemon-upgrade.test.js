import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import pkg from "../../package.json" with { type: "json" };

import { isAlive } from "../../src/cli/daemon-lifecycle.js";
import {
  createMockAcpTarget,
  runM87,
  waitFor,
} from "../support/e2e-harness.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(repoRoot, "src", "cli", "index.js");

const RECOMMENDATION = {
  recommendation: {
    summary: "Reply and fix",
    evidence: [],
    options: [
      {
        title: "Reply",
        rationale: "ack",
        confidence: "high",
        waiting_on: "user",
        actions: [
          { id: "a1", action_type: "comment", params: {}, required: true },
        ],
      },
    ],
  },
  usage: { tokens_in: 10 },
};

// The daemon polls the installed package.json and restarts itself when the
// version on disk no longer matches the version it loaded at startup - the
// upgrade path for a plain `npm install -g` where no m87 process gets a
// chance to run. M87_UPGRADE_PROBE_PATH stands in for the installed
// package.json so the test can "upgrade" without touching the repo.
describe("e2e: daemon restarts itself when the installed version changes", () => {
  let homeDir;
  let stateDir;
  let probePath;
  let env;
  let daemonRunning = false;

  const m87 = (...args) => runM87(CLI, args, env);
  const parse = ({ stdout }) => yaml.load(stdout);
  const writeProbe = (version) =>
    writeFileSync(probePath, JSON.stringify({ name: pkg.name, version }));
  const daemonPid = () => {
    const pidPath = join(stateDir, "daemon.pid");
    if (!existsSync(pidPath)) return null;
    const pid = Number(readFileSync(pidPath, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  };
  const daemonLog = () => {
    const logPath = join(stateDir, "daemon.log");
    return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  };

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "m87-selfrestart-"));
    stateDir = join(homeDir, ".m87");
    mkdirSync(stateDir, { recursive: true });
    probePath = join(homeDir, "installed-package.json");
    writeProbe(pkg.version);
    env = {
      ...process.env,
      HOME: homeDir,
      M87_STATE_DIR: stateDir,
      M87_SKIP_SHELLENV: "1",
      M87_AGENT_PROBE_PATH: "",
      M87_UPGRADE_PROBE_PATH: probePath,
      M87_UPGRADE_CHECK_INTERVAL: "200",
    };
    await m87("init");
  });

  afterEach(async () => {
    // Settle the probe so a respawned daemon stops detecting an upgrade,
    // then stop whichever daemon currently owns the pid file.
    writeProbe(pkg.version);
    if (daemonRunning) {
      try {
        await m87("daemon", "stop");
      } catch {
        // best-effort
      }
    }
    daemonRunning = false;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("drains, respawns onto the new install, and survives as a new process", async () => {
    await m87("daemon", "start");
    daemonRunning = true;
    const oldPid = await waitFor(daemonPid);
    expect(oldPid).toBeTruthy();

    writeProbe("99.0.0");
    const newPid = await waitFor(
      () => {
        const pid = daemonPid();
        return pid !== null && pid !== oldPid ? pid : null;
      },
      { timeoutMs: 20000 },
    );
    expect(newPid, daemonLog()).toBeTruthy();
    // The replacement keeps watching; settle the probe before it re-triggers.
    writeProbe(pkg.version);

    expect(await waitFor(() => !isAlive(oldPid))).toBe(true);
    const log = daemonLog();
    expect(log).toMatch(/upgrade detected, draining.*to=99\.0\.0/);
    expect(log).toMatch(/daemon restarting after upgrade/);

    const status = await waitFor(async () => {
      const s = parse(await m87("daemon", "status"));
      return s.running ? s : null;
    });
    expect(status, daemonLog()).toBeTruthy();
    expect(status.status).toBe("running");
    expect(status.pid).not.toBe(oldPid);
  });

  it("lets an in-flight agent turn finish before restarting", async () => {
    // An agent that takes seconds to answer keeps a triage effect in flight
    // while the "upgrade" lands underneath the daemon.
    const slow = await createMockAcpTarget(
      { homeDir, stateDir },
      { response: RECOMMENDATION, promptDelayMs: 5000 },
    );
    writeFileSync(
      join(stateDir, "config.yaml"),
      yaml.dump({
        agent: "acp:claude",
        poll_interval: 1,
        acp_registry_overrides: { claude: slow.executablePath },
        plugins: {},
      }),
    );
    await m87("plugin", "add", "mock");
    await m87("daemon", "start");
    daemonRunning = true;
    const oldPid = await waitFor(daemonPid);

    // The daemon syncs on its first tick, which triages the mock item. Catch
    // the turn while it is running - `m87 sync` is no good here, since it
    // blocks polling for results and would return only after the slow turn.
    const openDb = () => new Database(join(stateDir, "m87.sqlite"));
    const turnInFlight = await waitFor(() => {
      const db = openDb();
      const row = db
        .prepare("select id from agent_runs where status='running'")
        .get();
      db.close();
      return row ? true : null;
    });
    expect(turnInFlight, daemonLog()).toBe(true);

    writeProbe("99.0.0");
    const rejectedSync = await waitFor(async () => {
      try {
        await m87("sync");
        return null;
      } catch (err) {
        return err.stderr.includes("daemon restarting after upgrade")
          ? err
          : null;
      }
    });
    expect(rejectedSync.code).toBe(1);
    const newPid = await waitFor(
      () => {
        const pid = daemonPid();
        return pid !== null && pid !== oldPid ? pid : null;
      },
      { timeoutMs: 30000 },
    );
    expect(newPid, daemonLog()).toBeTruthy();
    writeProbe(pkg.version);

    // The drain began while the turn was running, and the restart waited for
    // it: one agent run, completed, its recommendation committed - not a
    // cancelled run retried by the replacement daemon.
    const log = daemonLog();
    // At least the triage turn was in flight when the drain began (a sync
    // effect may coincide, so the exact count can exceed one).
    expect(log).toMatch(/upgrade detected, draining.*in_flight=[1-9]/);
    expect(log.indexOf("upgrade detected, draining")).toBeLessThan(
      log.indexOf("daemon restarting after upgrade"),
    );
    const db = openDb();
    const runs = db.prepare("select status from agent_runs").all();
    db.close();
    expect(runs).toEqual([{ status: "completed" }]);
    const listed = parse(await m87("list"));
    expect(listed.inbox).toHaveLength(1);
  });
});
