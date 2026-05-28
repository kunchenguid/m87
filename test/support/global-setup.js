import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Must match TEST_PID_DIR in e2e-harness.js.
const pidDir = join(tmpdir(), "firstpass-test-pids");
// Only ever reap THIS repo's CLI - never a developer's installed `dist` daemon
// or an unrelated process the OS happened to recycle a pid into.
const cliPath = join(repoRoot, "src", "cli", "index.js");
const fixtureDir = join(repoRoot, "test", "support", "fixtures");

/**
 * Clear stale pid mirrors before the run so a previous crash can't make us
 * target a pid the OS has since reused.
 */
export async function setup() {
  await rm(pidDir, { recursive: true, force: true });
}

async function getCommand(pid) {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
    ]);
    return stdout;
  }

  const { stdout } = await execFileAsync("ps", [
    "-o",
    "command=",
    "-p",
    String(pid),
  ]);
  return stdout;
}

async function killProcessTree(pid) {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(pid), "/t", "/f"]);
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * After the whole run, reap any CLI subprocess a hard-killed worker stranded.
 * In-worker cleanup (e2e-harness `process.on("exit")`) handles the normal case;
 * this is the backstop for workers that died without running their handlers.
 */
export async function teardown() {
  let entries;
  try {
    entries = await readdir(pidDir);
  } catch {
    return; // nothing was tracked
  }
  await Promise.all(
    entries.map(async (name) => {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 1) return;
      let command;
      try {
        command = await getCommand(pid);
      } catch {
        return; // not alive
      }
      // Double-gate: pid was recorded by us AND the live command is still this
      // repo's CLI (or a test fixture). Anything else, we leave alone.
      if (!command.includes(cliPath) && !command.includes(fixtureDir)) return;
      try {
        await killProcessTree(pid);
      } catch {
        // already gone
      }
    }),
  );
  await rm(pidDir, { recursive: true, force: true });
}
