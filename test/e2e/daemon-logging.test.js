import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { waitFor } from "../support/e2e-harness.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(repoRoot, "src", "cli", "index.js");

// `firstpass daemon start` detaches the daemon and (the fix) redirects its
// stdout+stderr into daemon.log. Before the fix, stdio was discarded, so the
// advertised log file never existed and failures left no trace. This exercises
// the real production path (start -> log file written -> stop).
describe("e2e: daemon start writes operational logs to daemon.log", () => {
  let homeDir;
  let stateDir;
  let env;
  let started = false;

  const firstpass = (...args) =>
    execFileAsync(process.execPath, [CLI, ...args], { env });

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "firstpass-log-"));
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
    if (started) {
      try {
        await firstpass("daemon", "stop");
      } catch {
        // best-effort
      }
    }
    started = false;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("creates daemon.log and records the startup line", async () => {
    await firstpass("init");

    const res = await firstpass("daemon", "start");
    started = true;
    expect(res.stdout).toContain("daemon.log");

    const logPath = join(stateDir, "daemon.log");
    const log = await waitFor(() => {
      if (!existsSync(logPath)) return null;
      const text = readFileSync(logPath, "utf8");
      return text.includes("daemon started") ? text : null;
    });

    expect(log, "daemon.log should contain a startup line").toBeTruthy();
    expect(log).toContain("INFO");
    expect(log).toMatch(/daemon started.*pid=\d+/);
  });

  it("records the startup line after restart", async () => {
    await firstpass("init");

    await firstpass("daemon", "start");
    started = true;

    const logPath = join(stateDir, "daemon.log");
    await waitFor(() => {
      if (!existsSync(logPath)) return null;
      const text = readFileSync(logPath, "utf8");
      return text.includes("daemon started") ? text : null;
    });

    const res = await firstpass("daemon", "restart");
    expect(res.stdout).toContain("daemon.log");

    const log = await waitFor(() => {
      const text = readFileSync(logPath, "utf8");
      const startupLines = text.match(/daemon started.*pid=\d+/g) ?? [];
      return startupLines.length >= 2 ? text : null;
    });

    expect(log, "daemon.log should contain both startup lines").toBeTruthy();
    expect(log).toContain("INFO");
  });
});
