import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mockAgentCommand, readJsonLines } from "acp-mock";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
  const child = spawn(
    process.execPath,
    [join(repoRoot, "src", "cli", "index.js"), "daemon", "run"],
    { env, stdio: ["ignore", "ignore", "pipe"] },
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
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
