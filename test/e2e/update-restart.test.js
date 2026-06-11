import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import pkg from "../../package.json" with { type: "json" };

import { createControlServer } from "../../src/core/control.js";
import { controlAddress } from "../../src/cli/state.js";
import { runM87, waitFor } from "../support/e2e-harness.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(repoRoot, "src", "cli", "index.js");

// A daemon keeps executing the code it loaded at startup, so a global npm
// upgrade leaves it live but stale. These tests cover the two halves of the
// fix: `m87 update` restarts the daemon onto the new install, and
// `m87 daemon status` flags a version mismatch it cannot fix itself.
describe("e2e: update restarts the daemon onto the new install", () => {
  let homeDir;
  let stateDir;
  let env;
  let daemonStarted = false;

  const m87 = (...args) => runM87(CLI, args, env);
  const parse = ({ stdout }) => yaml.load(stdout);

  // `m87 update` shells out to `npm install -g`. The shim stands in for npm so
  // the test can assert the exact install spec without touching the network or
  // the real global prefix.
  const installNpmShim = (binDir, argsLog) => {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "npm"),
      `#!/bin/sh\nprintf '%s' "$*" > "${argsLog}"\n`,
    );
    chmodSync(join(binDir, "npm"), 0o755);
    writeFileSync(
      join(binDir, "npm.cmd"),
      `@echo %* > "${argsLog}"\r\n@exit /b 0\r\n`,
    );
  };

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "m87-update-"));
    stateDir = join(homeDir, ".m87");
    env = {
      ...process.env,
      HOME: homeDir,
      M87_STATE_DIR: stateDir,
      M87_SKIP_SHELLENV: "1",
      M87_AGENT_PROBE_PATH: "",
    };
    await m87("init");
  });

  afterEach(async () => {
    if (daemonStarted) {
      try {
        await m87("daemon", "stop");
      } catch {
        // best-effort
      }
    }
    daemonStarted = false;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("installs the scoped package and restarts the running daemon", async () => {
    await m87("daemon", "start");
    daemonStarted = true;
    const pidPath = join(stateDir, "daemon.pid");
    await waitFor(() => existsSync(pidPath));
    const oldPid = Number(readFileSync(pidPath, "utf8"));

    const binDir = join(homeDir, "bin");
    const argsLog = join(homeDir, "npm-args.txt");
    installNpmShim(binDir, argsLog);
    const pathKey =
      Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ??
      "PATH";
    env = {
      ...env,
      [pathKey]: `${binDir}${delimiter}${process.env[pathKey]}`,
      M87_LATEST_VERSION: "99.0.0",
    };

    const updated = parse(await m87("update"));
    expect(updated.status).toBe("updated");
    expect(updated.applied).toBe(true);
    // The regression under test: the exec'd spec was the unscoped `m87`,
    // a different npm package, while the displayed command was scoped.
    expect(updated.command).toBe(`npm install -g ${pkg.name}@99.0.0`);
    expect(readFileSync(argsLog, "utf8")).toContain(
      `install -g ${pkg.name}@99.0.0`,
    );
    // The old daemon would keep running pre-upgrade code; update must have
    // replaced it with a fresh process.
    expect(updated.daemon.status).toBe("restarted");
    expect(updated.daemon.pid).not.toBe(oldPid);
    await waitFor(
      () =>
        existsSync(pidPath) &&
        Number(readFileSync(pidPath, "utf8")) === updated.daemon.pid,
    );
  });

  it("update leaves a stopped daemon stopped", async () => {
    const binDir = join(homeDir, "bin");
    const argsLog = join(homeDir, "npm-args.txt");
    installNpmShim(binDir, argsLog);
    const pathKey =
      Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ??
      "PATH";
    env = {
      ...env,
      [pathKey]: `${binDir}${delimiter}${process.env[pathKey]}`,
      M87_LATEST_VERSION: "99.0.0",
    };

    const updated = parse(await m87("update"));
    expect(updated.status).toBe("updated");
    expect(updated.daemon.status).toBe("not_running");
    expect(existsSync(join(stateDir, "daemon.pid"))).toBe(false);
  });

  it("daemon status reports running_stale for a daemon on another version", async () => {
    // Stand in for a daemon left over from a previous install: a live pid
    // (this test process) behind a control server that answers ping with the
    // old version.
    mkdirSync(stateDir, { recursive: true });
    const server = await createControlServer(
      controlAddress(stateDir),
      (msg) => {
        if (msg?.cmd === "ping") {
          return { ok: true, pid: process.pid, version: "0.0.1" };
        }
        return { ok: false, error: "unexpected" };
      },
    );
    writeFileSync(join(stateDir, "daemon.pid"), String(process.pid));
    try {
      const status = parse(await m87("daemon", "status"));
      expect(status.status).toBe("running_stale");
      expect(status.running).toBe(true);
      expect(status.version).toBe("0.0.1");
      expect(status.cli_version).toBe(pkg.version);
      expect(status.hint).toContain("m87 daemon restart");
    } finally {
      server.close();
      rmSync(join(stateDir, "daemon.pid"), { force: true });
    }
  });
});
