import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";

// State lives under a single state dir: ~/.firstpass by default, overridable with
// FIRSTPASS_STATE_DIR (tests) or HOME (the e2e harness).
export function getStatePaths() {
  const stateDir = process.env.FIRSTPASS_STATE_DIR || join(homedir(), ".firstpass");
  return {
    stateDir,
    dbPath: join(stateDir, "firstpass.sqlite"),
    configPath: join(stateDir, "config.yaml"),
    pidPath: join(stateDir, "daemon.pid"),
    logPath: join(stateDir, "daemon.log"),
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
