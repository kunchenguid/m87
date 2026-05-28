import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMockAcpTarget,
  runFirstpass,
  startFirstpassDaemon,
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

describe("e2e: daemon run shuts down promptly while a slow turn is in flight", () => {
  let homeDir;
  let stateDir;
  let env;
  let daemon;

  const firstpass = (...args) => runFirstpass(CLI, args, env);
  const openDb = () => new Database(join(stateDir, "firstpass.sqlite"));

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "firstpass-shutdown-"));
    stateDir = join(homeDir, ".firstpass");
    env = {
      ...process.env,
      HOME: homeDir,
      FIRSTPASS_STATE_DIR: stateDir,
      FIRSTPASS_SKIP_SHELLENV: "1",
      FIRSTPASS_AGENT_PROBE_PATH: "",
    };
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  // Start a daemon against an agent that takes 30s to respond, then return once
  // a triage turn is genuinely mid-flight (its subprocess holding the event
  // loop open). Shutdown must beat that 30s delay.
  async function startDaemonWithInFlightTurn() {
    const slow = await createMockAcpTarget(
      { homeDir, stateDir },
      { response: RECOMMENDATION, promptDelayMs: 30000 },
    );
    await firstpass("init");
    writeFileSync(
      join(stateDir, "config.yaml"),
      yaml.dump({
        agent: "acp:claude",
        poll_interval: 1,
        acp_registry_overrides: { claude: slow.executablePath },
        plugins: {},
      }),
    );
    await firstpass("plugin", "add", "mock");

    daemon = startFirstpassDaemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    await firstpass("sync");

    const running = await waitFor(() => {
      const db = openDb();
      const row = db
        .prepare("select id from agent_runs where status='running'")
        .get();
      db.close();
      return row ? true : null;
    });
    expect(running, daemon.stderr).toBe(true);
  }

  // The cross-platform path: `firstpass daemon stop` over the control socket
  // (UDS on POSIX, named pipe on Windows). This is the only graceful shutdown
  // available on Windows, which has no POSIX signals.
  it("exits within seconds of a control-channel stop request", async () => {
    await startDaemonWithInFlightTurn();

    const start = Date.now();
    await firstpass("daemon", "stop");
    const exitedInTime = await Promise.race([
      daemon.exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
    expect(exitedInTime, daemon.stderr).toBe(true);
    expect(Date.now() - start).toBeLessThan(8000);
    daemon = undefined; // already exited; skip afterEach stop
  });

  // POSIX terminal/service shutdown (Ctrl-C, systemd SIGTERM). Skipped on
  // Windows, which delivers no catchable SIGINT - there the control-channel
  // stop above is the graceful path.
  it.skipIf(process.platform === "win32")(
    "exits within seconds of SIGINT",
    async () => {
      await startDaemonWithInFlightTurn();

      const start = Date.now();
      daemon.signal("SIGINT");
      const exitedInTime = await Promise.race([
        daemon.exited.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 8000)),
      ]);
      expect(exitedInTime, daemon.stderr).toBe(true);
      expect(Date.now() - start).toBeLessThan(8000);
      daemon = undefined; // already exited; skip afterEach stop
    },
  );
});
