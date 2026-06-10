import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sendControl } from "../core/control.js";
import { getServicePlan, isServiceDryRun } from "./service.js";
import { getStatePaths } from "./state.js";

// Daemon process lifecycle shared by the CLI commands and the setup flow, so
// both sides agree on what "running" means (a live process behind the pid
// file in the state dir) and on how a daemon is started, stopped, and handed
// over to the managed login service.

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Pid of the live daemon recorded in the state dir, or null.
export function runningDaemonPid() {
  const { pidPath } = getStatePaths();
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8"));
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
}

// Graceful, cross-platform daemon stop: ask over the control channel first,
// fall back to a signal (forcible on Windows), then wait briefly for exit.
export async function gracefulStopDaemon() {
  const { controlAddress } = getStatePaths();
  const pid = runningDaemonPid();
  if (pid === null) return { status: "not_running" };
  try {
    await sendControl(controlAddress, { cmd: "stop" }, { timeoutMs: 3000 });
  } catch {
    // Control channel unreachable (e.g. a pre-socket daemon): fall back to a
    // signal.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return { status: "not_running" };
    }
  }
  for (let i = 0; i < 80 && isAlive(pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { status: isAlive(pid) ? "stopping" : "stopped", pid };
}

// Start `m87 daemon run` detached, with stdout/stderr appended to daemon.log:
// the daemon logs to stderr and relies on its spawner for redirection, so
// every start path must wire the log file or operational events are lost.
// No-op when a daemon is already running.
export function startDetachedDaemon(cliEntry) {
  const { logPath } = getStatePaths();
  const pid = runningDaemonPid();
  if (pid !== null) return { status: "already_running", pid };
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [cliEntry, "daemon", "run"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  return { status: "started", pid: child.pid, log: logPath };
}

// Write and activate the managed login service. A session daemon and the
// service-spawned daemon would fight over the pid file and control socket
// (the newcomer silently hijacks both, orphaning the older process while the
// service manager keeps its own instance alive), so any running daemon is
// gracefully stopped first and the service owns the process from then on.
export async function installManagedService(cliEntry) {
  const { stateDir } = getStatePaths();
  const plan = getServicePlan(stateDir, cliEntry);
  if (!plan) {
    return { status: "unsupported", platform: process.platform };
  }
  const stopped =
    runningDaemonPid() !== null ? await gracefulStopDaemon() : null;
  if (stopped?.status === "stopping") {
    return {
      status: "stop_failed",
      manager: plan.manager,
      label: plan.label,
      unit: plan.unitPath,
      stopped,
    };
  }
  await mkdir(dirname(plan.unitPath), { recursive: true });
  await writeFile(plan.unitPath, plan.content);
  let activation = "skipped_dry_run";
  if (!isServiceDryRun()) {
    try {
      execFileSync(plan.activate.command, plan.activate.args, {
        stdio: "ignore",
        timeout: 10000,
      });
      activation = "activated";
    } catch {
      activation = "write_only_activation_failed";
    }
  }
  if (
    activation === "write_only_activation_failed" &&
    stopped?.status === "stopped"
  ) {
    const restored = startDetachedDaemon(cliEntry);
    return {
      status: "activation_failed",
      manager: plan.manager,
      label: plan.label,
      unit: plan.unitPath,
      activation,
      stopped,
      restored,
    };
  }
  return {
    status: "installed",
    manager: plan.manager,
    label: plan.label,
    unit: plan.unitPath,
    activation,
    stopped,
  };
}

export async function uninstallManagedService(cliEntry) {
  const { stateDir } = getStatePaths();
  const plan = getServicePlan(stateDir, cliEntry);
  if (!plan) {
    return { status: "unsupported", platform: process.platform };
  }
  if (!existsSync(plan.unitPath)) {
    return { status: "no_op", manager: plan.manager };
  }
  let deactivation = "skipped_dry_run";
  if (!isServiceDryRun()) {
    try {
      execFileSync(plan.deactivate.command, plan.deactivate.args, {
        stdio: "ignore",
        timeout: 10000,
      });
      deactivation = "deactivated";
    } catch {
      deactivation = "deactivate_failed";
    }
  }
  await rm(plan.unitPath, { force: true });
  return {
    status: "uninstalled",
    manager: plan.manager,
    label: plan.label,
    unit: plan.unitPath,
    deactivation,
  };
}
