import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mockAgentCommand, readJsonLines } from "acp-mock";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// --- stray-process reaping --------------------------------------------------
// The e2e suite spawns the real CLI as many short-lived `node` subprocesses
// (plus a long-lived daemon), each of which can fork plugin grandchildren. If
// an invocation wedges, or a worker dies before its `afterEach` runs, those
// processes used to be reparented to init and sit there eating memory forever.
// Every spawned child is launched in its OWN process group, tracked here, and
// group-killed on teardown / abnormal exit. We also mirror each pid into a
// run-scoped directory so the top-level globalTeardown can sweep anything a
// hard-killed worker leaves behind. See test/support/global-setup.js.

export const TEST_PID_DIR = join(tmpdir(), "firstpass-test-pids");
const liveChildren = new Set();

function trackChild(child) {
  if (child.pid === undefined) return child;
  liveChildren.add(child);
  // Best-effort pid mirror for the cross-worker sweep; never blocks the test.
  mkdir(TEST_PID_DIR, { recursive: true })
    .then(() => writeFile(join(TEST_PID_DIR, String(child.pid)), ""))
    .catch(() => undefined);
  const drop = () => {
    liveChildren.delete(child);
    rm(join(TEST_PID_DIR, String(child.pid)), { force: true }).catch(
      () => undefined,
    );
  };
  child.once("exit", drop);
  child.once("close", drop);
  return child;
}

/** Kill a child's whole process group (CLI parent + plugin grandchildren). */
export function killChild(child, signal = "SIGKILL") {
  if (!child || child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
    return;
  }
  try {
    // Detached children lead their own group; the negative pid signals the
    // whole group, so plugin grandchildren die with the CLI parent.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Reap every still-live tracked child. Safe to call repeatedly. */
export function killStrayTestProcesses() {
  for (const child of liveChildren) killChild(child);
  liveChildren.clear();
}

let sweeperInstalled = false;
function installSweeper() {
  if (sweeperInstalled) return;
  sweeperInstalled = true;
  process.once("exit", killStrayTestProcesses);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      killStrayTestProcesses();
      process.exit(1);
    });
  }
}
installSweeper();

/**
 * Run the firstpass CLI as a tracked subprocess in its own process group with
 * a hard timeout. Resolves to `{ stdout, stderr }` on a clean exit; otherwise
 * rejects with an Error carrying `.code`, `.stdout`, `.stderr`, and `.timedOut`
 * - the same shape tests relied on from `promisify(execFile)`.
 *
 * @param {string} cliPath
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runFirstpass(cliPath, args, env, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = trackChild(
      spawn(process.execPath, [cliPath, ...args], {
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }
      const label = `firstpass ${args.join(" ")}`;
      reject(
        Object.assign(
          new Error(
            timedOut
              ? `${label} timed out after ${timeoutMs}ms`
              : `${label} exited with ${code}: ${stderr}`,
          ),
          { code: code ?? undefined, stdout, stderr, timedOut },
        ),
      );
    });
    child.stdin.end();
  });
}
const acpMockBinPath = join(
  repoRoot,
  "node_modules",
  "acp-mock",
  "dist",
  "cli.js",
);

/**
 * @typedef {object} FirstpassTestWorkspace
 * @property {string} homeDir
 * @property {string} binDir
 * @property {string} stateDir
 * @property {NodeJS.ProcessEnv} env
 * @property {() => Promise<void>} cleanup
 */

/**
 * @typedef {object} MockAcpTarget
 * @property {string} executablePath
 * @property {string} eventLogPath
 * @property {() => Promise<Array<Record<string, unknown>>>} readEvents
 */

/**
 * @returns {Promise<FirstpassTestWorkspace>}
 */
export async function createFirstpassTestWorkspace() {
  const homeDir = await mkdtemp(join(tmpdir(), "firstpass-home-"));
  const binDir = join(homeDir, "bin");
  const stateDir = join(homeDir, ".firstpass");

  await mkdir(binDir, { recursive: true });

  return {
    homeDir,
    binDir,
    stateDir,
    env: { ...process.env, HOME: homeDir },
    cleanup: async () => {
      await rm(homeDir, { force: true, recursive: true });
    },
  };
}

/**
 * @param {FirstpassTestWorkspace} workspace
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runBuiltFirstpass(workspace, args) {
  return execFileAsync(process.execPath, ["src/cli/index.js", ...args], {
    env: workspace.env,
  });
}

/**
 * Start the firstpass daemon (the sole loop/consumer) as a background process.
 * Returns a handle with `.stop()` and captured stderr. Config must be written
 * before calling so the daemon loads the agent target.
 */
export function startFirstpassDaemon(env) {
  // Detached so the daemon leads its own process group: cleanup can group-kill
  // it together with any plugin grandchildren it spawned mid-sync. `.signal()`
  // / `.stop()` below still target the daemon's pid alone (not the group), so
  // the shutdown tests keep exercising single-process signal delivery.
  const child = trackChild(
    spawn(
      process.execPath,
      [join(repoRoot, "src", "cli", "index.js"), "daemon", "run"],
      { env, detached: true, stdio: ["ignore", "ignore", "pipe"] },
    ),
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    pid: child.pid,
    get stderr() {
      return stderr;
    },
    // Deliver an arbitrary signal (e.g. SIGINT) to the daemon process only -
    // not its children - so tests can exercise terminal-style shutdown.
    signal: (sig) => {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    },
    // Resolves when the daemon process exits.
    exited,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** Poll `fn` until it returns truthy or the timeout elapses. */
export async function waitFor(
  fn,
  { timeoutMs = 10000, intervalMs = 120 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * @param {string} pluginPath
 * @param {string[]} args
 * @param {unknown} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runSourcePlugin(
  pluginPath,
  args,
  input,
  env = process.env,
) {
  return runExecutableWithJsonInput(
    process.execPath,
    [pluginPath, ...args],
    input,
    env,
  );
}

/**
 * @param {{ homeDir: string, stateDir?: string }} workspace
 * @param {{ response?: unknown, usage?: { tokens_in?: number, tokens_out?: number }, runtimeEventsPath?: string, promptDelayMs?: number }} options
 * @returns {Promise<MockAcpTarget>}
 */
export async function createMockAcpTarget(workspace, options = {}) {
  const response = Reflect.has(options, "response")
    ? Reflect.get(options, "response")
    : { status: "ok" };
  const usage = Reflect.get(options, "usage");
  const eventLogPath = join(workspace.homeDir, "mock-acp-events.jsonl");
  const executablePath = mockAgentCommand({
    bin: acpMockBinPath,
    eventLogPath,
    runtimeEventsPath:
      typeof Reflect.get(options, "runtimeEventsPath") === "string"
        ? Reflect.get(options, "runtimeEventsPath")
        : undefined,
    agentMessageJson: response,
    usageUpdateUsed:
      usage !== null && typeof usage === "object"
        ? Reflect.get(usage, "tokens_in")
        : undefined,
    promptDelayMs:
      typeof Reflect.get(options, "promptDelayMs") === "number"
        ? Reflect.get(options, "promptDelayMs")
        : undefined,
  });

  return {
    executablePath,
    eventLogPath,
    readEvents: async () => readJsonLines(await readFile(eventLogPath, "utf8")),
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {unknown} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runExecutableWithJsonInput(command, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = trackChild(
      spawn(command, args, {
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}
