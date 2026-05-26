import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";

// The CLI talks to the running daemon over a local control channel. POSIX uses a
// Unix domain socket inside the state dir (so it is naturally isolated per state
// dir); Windows has no UDS, so we use a named pipe whose name is derived from the
// state dir - named pipes are machine-global, so the hash keeps separate state
// dirs (e.g. concurrent test workspaces) from colliding.
export function controlAddress(stateDir) {
  if (process.platform === "win32") {
    const id = createHash("sha1").update(stateDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\firstpass-${id}`;
  }
  return join(stateDir, "daemon.sock");
}

// State lives under a single state dir: ~/.firstpass by default, overridable with
// FIRSTPASS_STATE_DIR (tests) or HOME (the e2e harness).
export function getStatePaths() {
  const stateDir =
    process.env.FIRSTPASS_STATE_DIR || join(homedir(), ".firstpass");
  return {
    stateDir,
    dbPath: join(stateDir, "firstpass.sqlite"),
    configPath: join(stateDir, "config.yaml"),
    pidPath: join(stateDir, "daemon.pid"),
    logPath: join(stateDir, "daemon.log"),
    controlAddress: controlAddress(stateDir),
  };
}

export const DEFAULT_CONFIG = {
  agent: null, // acp:<target> or null to auto-detect
  poll_interval: 300,
  acp_registry_overrides: {},
  plugins: {},
};

export function loadConfig() {
  const { configPath } = getStatePaths();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const parsed = yaml.load(readFileSync(configPath, "utf8")) ?? {};
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function saveConfig(config) {
  const { stateDir, configPath } = getStatePaths();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, yaml.dump(config), "utf8");
}

export function ensureStateDir() {
  const { stateDir } = getStatePaths();
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}
