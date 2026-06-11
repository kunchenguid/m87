import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sendControl } from "../core/control.js";
import {
  getDaemonInvocationArgs,
  getServiceLabel,
  getServicePlan,
  isServiceDryRun,
} from "./service.js";
import { getStatePaths } from "./state.js";

/** @typedef {"match" | "mismatch" | "unknown"} DaemonPidIdentity */

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

function forgetDaemonPid() {
  const { pidPath } = getStatePaths();
  rmSync(pidPath, { force: true });
}

// A stale pid file can record a pid the OS has since recycled into an
// unrelated process, and isAlive() cannot tell the two apart. The signal
// fallback in gracefulStopDaemon must never fire on such a pid - on Windows
// the emulated SIGTERM is an unconditional TerminateProcess - so the live
// process's command line has to look like `... daemon run` first.
/** @returns {DaemonPidIdentity} */
function daemonPidIdentity(pid) {
  try {
    const { stateDir } = getStatePaths();
    const token = getServiceLabel(stateDir);
    const command =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
            ],
            { encoding: "utf8", timeout: 10000 },
          )
        : execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
            timeout: 10000,
          });
    const commandText = String(command ?? "");
    if (!/\bdaemon\s+run\b/.test(commandText)) return "mismatch";
    if (!commandText.includes("--state-token")) return "match";
    return commandText.includes(token) ? "match" : "mismatch";
  } catch {
    return "unknown";
  }
}

/** @param {DaemonPidIdentity | boolean} identity */
function isDaemonPidMatch(identity) {
  return identity === true || identity === "match";
}

/** @param {DaemonPidIdentity | boolean} identity */
function isDaemonPidMismatch(identity) {
  return identity === false || identity === "mismatch";
}

// Graceful, cross-platform daemon stop: ask over the control channel first,
// fall back to a signal (forcible on Windows), then wait briefly for exit.
// `confirmDaemonPid` exists for tests that stand in fake daemons.
/**
 * @param {{ confirmDaemonPid?: (pid: number) => DaemonPidIdentity | boolean | Promise<DaemonPidIdentity | boolean> }} [options]
 */
export async function gracefulStopDaemon({
  confirmDaemonPid = daemonPidIdentity,
} = {}) {
  const { controlAddress } = getStatePaths();
  const pid = runningDaemonPid();
  if (pid === null) return { status: "not_running" };
  try {
    await sendControl(controlAddress, { cmd: "stop" }, { timeoutMs: 3000 });
  } catch {
    // Control channel unreachable (e.g. a pre-socket daemon): fall back to a
    // signal, but only onto a verified daemon process - never a pid the OS
    // recycled into something else.
    const identity = await confirmDaemonPid(pid);
    if (!isDaemonPidMatch(identity)) {
      if (isDaemonPidMismatch(identity)) forgetDaemonPid();
      return { status: "not_running" };
    }
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
  const { logPath, stateDir } = getStatePaths();
  const pid = runningDaemonPid();
  if (pid !== null) {
    const identity = daemonPidIdentity(pid);
    if (!isDaemonPidMismatch(identity)) {
      return { status: "already_running", pid };
    }
    forgetDaemonPid();
  }
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  let child;
  try {
    child = spawn(
      process.execPath,
      getDaemonInvocationArgs(stateDir, cliEntry),
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      },
    );
  } finally {
    closeSync(logFd);
  }
  child.unref();
  return { status: "started", pid: child.pid, log: logPath };
}

// True when a managed service unit exists for this state dir, meaning the
// service manager - not the CLI - owns the daemon process.
export function managedServiceExists(cliEntry) {
  const { stateDir } = getStatePaths();
  const plan = getServicePlan(stateDir, cliEntry);
  return plan !== null && existsSync(plan.unitPath);
}

// Restart the daemon so it runs the code currently installed at `cliEntry`.
// A service-managed daemon is respawned by its manager whenever it exits
// (launchd KeepAlive, systemd Restart), so stopping it directly and spawning
// a detached replacement would race the manager and stack two daemons.
// Instead the restart goes through the manager: deactivate, stop any
// straggler the manager does not own (schtasks never stops the process),
// then activate so the manager spawns the fresh code.
/**
 * @param {string} cliEntry
 * @param {{ confirmDaemonPid?: (pid: number) => DaemonPidIdentity | boolean | Promise<DaemonPidIdentity | boolean> }} [options]
 */
export async function restartDaemon(cliEntry, { confirmDaemonPid } = {}) {
  const { stateDir } = getStatePaths();
  const plan = getServicePlan(stateDir, cliEntry);
  if (plan !== null && plan.manager !== "schtasks" && existsSync(plan.unitPath)) {
    if (!isServiceDryRun()) {
      try {
        execFileSync(plan.deactivate.command, plan.deactivate.args, {
          stdio: "ignore",
          timeout: 15000,
        });
      } catch {
        // The unit may not be loaded (e.g. written but never activated);
        // activation below is the step that has to succeed.
      }
    }
    const stopped = await gracefulStopDaemon({ confirmDaemonPid });
    if (!isServiceDryRun()) {
      try {
        execFileSync(plan.activate.command, plan.activate.args, {
          stdio: "ignore",
          timeout: 15000,
        });
      } catch (err) {
        return {
          status: "restart_failed",
          manager: plan.manager,
          unit: plan.unitPath,
          reason: String(err?.message ?? err),
        };
      }
    }
    return {
      status: "restarted",
      manager: plan.manager,
      unit: plan.unitPath,
      stopped: stopped.pid ?? null,
    };
  }
  const stopped = await gracefulStopDaemon({ confirmDaemonPid });
  const started = startDetachedDaemon(cliEntry);
  if (started.status !== "started") {
    // The old daemon survived the stop window; report it rather than
    // stacking a second instance on top of it.
    return { status: "stop_failed", pid: started.pid };
  }
  return {
    status: "restarted",
    pid: started.pid,
    log: started.log,
    stopped: stopped.pid ?? null,
  };
}

// Write and activate the managed login service. A session daemon and the
// service-spawned daemon would fight over the pid file and control socket
// (the newcomer silently hijacks both, orphaning the older process while the
// service manager keeps its own instance alive), so any running daemon is
// gracefully stopped first and the service owns the process from then on.
/**
 * @param {string} cliEntry
 * @param {{ confirmDaemonPid?: (pid: number) => DaemonPidIdentity | boolean | Promise<DaemonPidIdentity | boolean> }} [options]
 */
export async function installManagedService(
  cliEntry,
  { confirmDaemonPid } = {},
) {
  const { stateDir } = getStatePaths();
  const plan = getServicePlan(stateDir, cliEntry);
  if (!plan) {
    return { status: "unsupported", platform: process.platform };
  }
  const unitExistedBeforeInstall = existsSync(plan.unitPath);
  const stopped =
    runningDaemonPid() !== null
      ? await gracefulStopDaemon({ confirmDaemonPid })
      : null;
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
    stopped?.status === "stopped" &&
    !unitExistedBeforeInstall
  ) {
    await rm(plan.unitPath, { force: true });
    const restored = startDetachedDaemon(cliEntry);
    return {
      status: "activation_failed",
      manager: plan.manager,
      label: plan.label,
      unit: plan.unitPath,
      activation,
      stopped,
      unitExistedBeforeInstall,
      restored,
    };
  }
  if (
    activation === "write_only_activation_failed" &&
    stopped?.status === "stopped"
  ) {
    return {
      status: "activation_failed",
      manager: plan.manager,
      label: plan.label,
      unit: plan.unitPath,
      activation,
      stopped,
      unitExistedBeforeInstall,
    };
  }
  return {
    status: "installed",
    manager: plan.manager,
    label: plan.label,
    unit: plan.unitPath,
    activation,
    stopped,
    unitExistedBeforeInstall,
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
  if (deactivation === "deactivate_failed") {
    return {
      status: "uninstalled",
      manager: plan.manager,
      label: plan.label,
      unit: plan.unitPath,
      deactivation,
    };
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
