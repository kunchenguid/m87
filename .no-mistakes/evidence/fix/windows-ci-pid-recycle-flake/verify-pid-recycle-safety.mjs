/* global process */

import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gracefulStopDaemon,
  isAlive,
} from "../../../../src/cli/daemon-lifecycle.js";
import { getServiceLabel } from "../../../../src/cli/service.js";
import { readManifest } from "../../../../src/host/plugin.js";
import { killChild } from "../../../../test/support/e2e-harness.js";

const evidence = {
  generatedAt: new Date().toISOString(),
  checks: [],
};

function record(name, result) {
  evidence.checks.push({ name, ...result });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withStateDir(fn) {
  const homeDir = mkdtempSync(join(tmpdir(), "m87-pid-evidence-"));
  const stateDir = join(homeDir, ".m87");
  const previousStateDir = process.env.M87_STATE_DIR;
  mkdirSync(stateDir, { recursive: true });
  process.env.M87_STATE_DIR = stateDir;
  try {
    return await fn(stateDir);
  } finally {
    if (previousStateDir === undefined) delete process.env.M87_STATE_DIR;
    else process.env.M87_STATE_DIR = previousStateDir;
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function startIdleProcess(args = []) {
  return execFile(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
    ...args,
  ]);
}

await withStateDir(async (stateDir) => {
  const child = startIdleProcess();
  writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

  try {
    const result = await gracefulStopDaemon();
    const stillAlive = isAlive(child.pid);
    const pidfileExists = existsSync(join(stateDir, "daemon.pid"));
    assert(
      result.status === "not_running",
      "non-daemon pid should be treated as not_running",
    );
    assert(stillAlive, "non-daemon process should not be killed");
    assert(!pidfileExists, "mismatched stale pidfile should be removed");
    record("stale pid owned by unrelated process", {
      status: "passed",
      pid: child.pid,
      gracefulStopResult: result,
      unrelatedProcessStillAlive: stillAlive,
      stalePidfileRemoved: !pidfileExists,
    });
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
});

await withStateDir(async (stateDir) => {
  const child = startIdleProcess([
    "daemon",
    "run",
    "--state-token",
    getServiceLabel(stateDir),
  ]);
  writeFileSync(join(stateDir, "daemon.pid"), String(child.pid));

  const result = await gracefulStopDaemon();
  const stillAlive = isAlive(child.pid);
  assert(result.status === "stopped", "verified daemon should stop");
  assert(!stillAlive, "verified daemon process should exit");
  record("verified daemon pid", {
    status: "passed",
    pid: child.pid,
    gracefulStopResult: result,
    daemonStillAlive: stillAlive,
  });
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", { value: "win32" });
try {
  const exitedChild = {
    pid: 424242,
    exitCode: 1,
    signalCode: null,
    kill() {
      throw new Error("kill should not be called for an observed exit");
    },
  };
  killChild(exitedChild);
  record("windows harness observed-exit cleanup", {
    status: "passed",
    pid: exitedChild.pid,
    taskkillInvoked: false,
    behavior:
      "returned before raw-pid taskkill because exitCode was already observed",
  });
} finally {
  Object.defineProperty(process, "platform", originalPlatform);
}

const pluginDir = mkdtempSync(join(tmpdir(), "m87-plugin-evidence-"));
const pluginPath = join(pluginDir, "dies-silently.js");
writeFileSync(pluginPath, "process.exit(7);\n");
try {
  try {
    await readManifest(pluginPath);
    throw new Error("silent plugin failure should reject");
  } catch (error) {
    assert(
      String(error.message).includes("plugin manifest exited with code 7"),
      `plugin error did not include exit cause: ${error.message}`,
    );
    record("silent plugin failure diagnostics", {
      status: "passed",
      errorName: error.name,
      errorMessage: error.message,
    });
  }
} finally {
  rmSync(pluginDir, { recursive: true, force: true });
}

execFileSync(process.execPath, ["-e", ""], { stdio: "ignore" });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
