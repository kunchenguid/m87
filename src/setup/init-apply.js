import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createDatabase } from "../core/database.js";
import { pluginConfigure, readManifest } from "../host/plugin.js";
import { getServicePlan, isServiceDryRun } from "../cli/service.js";
import {
  ensureStateDir,
  getStatePaths,
  loadConfig,
  saveConfig,
} from "../cli/state.js";

export function seedRetentionPolicy(db) {
  const exists = db
    .prepare("select id from retention_policies where id='retention-default'")
    .get();
  if (exists) return;
  const now = new Date().toISOString();
  db.prepare(
    `insert into retention_policies (id, scope, raw_context_ttl, prompt_ttl, draft_ttl, attachment_ttl, audit_ttl, created_at, updated_at)
     values ('retention-default','global','7d','30d','30d','7d','365d',?,?)`,
  ).run(now, now);
}

export function initializeCoreState(configPatch = {}) {
  const stateDir = ensureStateDir();
  const { dbPath, configPath } = getStatePaths();
  const db = createDatabase(dbPath);
  seedRetentionPolicy(db);
  db.close();
  const nextConfig = { ...loadConfig(), ...configPatch };
  if (!existsSync(configPath) || Object.keys(configPatch).length > 0) {
    saveConfig(nextConfig);
  }
  return { stateDir, config: nextConfig };
}

export async function installBundledPlugin({
  pluginId,
  pluginConfig = {},
  bundledPluginPaths,
}) {
  const binaryPath = bundledPluginPaths[pluginId];
  if (!binaryPath || !existsSync(binaryPath)) {
    throw new Error(`unknown plugin: ${pluginId}`);
  }
  const manifest = await readManifest(binaryPath);
  const { dbPath } = getStatePaths();
  const db = createDatabase(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    `insert or replace into plugins (id, binary_path, version, protocol_version, manifest_json, config_json, status, installed_at)
     values (?,?,?,?,?,?, 'active', ?)`,
  ).run(
    manifest.plugin.id,
    binaryPath,
    manifest.plugin.version,
    manifest.protocol_version,
    JSON.stringify(manifest),
    JSON.stringify(pluginConfig),
    now,
  );
  db.close();

  let configure = null;
  try {
    configure = await pluginConfigure(binaryPath, pluginConfig);
  } catch (error) {
    configure = { warnings: [error.message], credentials_required: true };
  }

  return { manifest, configure };
}

export async function installManagedService(cliEntry) {
  const { stateDir } = getStatePaths();
  const plan = getServicePlan(stateDir, cliEntry);
  if (!plan) {
    return { status: "unsupported", platform: process.platform };
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
  return {
    status: "installed",
    manager: plan.manager,
    label: plan.label,
    unit: plan.unitPath,
    activation,
  };
}

export function startDetachedDaemon(cliEntry) {
  const { logPath, pidPath } = getStatePaths();
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8"));
    if (Number.isInteger(pid) && isAlive(pid)) {
      return { status: "already_running", pid };
    }
  }
  const child = spawn(process.execPath, [cliEntry, "daemon", "run"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  child.unref();
  return { status: "started", pid: child.pid, log: logPath };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function applyInitPlan(plan, { bundledPluginPaths, cliEntry }) {
  const initialized = initializeCoreState({ agent: plan.agent.configValue });
  const result = {
    status: "initialized",
    mode: "headless",
    state_dir: initialized.stateDir,
    agent: { mode: plan.agent.mode, target: plan.agent.configValue },
    source: { type: plan.source.type },
    service: { status: "skipped" },
    daemon: { status: "not_started" },
    commands: plan.commands,
    warnings: [],
  };

  if (plan.source.type === "github") {
    const installed = await installBundledPlugin({
      pluginId: "github",
      pluginConfig: plan.source.config,
      bundledPluginPaths,
    });
    result.source = {
      type: "github",
      plugin: installed.manifest.plugin.id,
      display_name: installed.configure?.display_name ?? "GitHub",
      credentials_required: Boolean(installed.configure?.credentials_required),
    };
    result.warnings.push(...(installed.configure?.warnings ?? []));
  }

  if (plan.daemon.installService) {
    result.service = await installManagedService(cliEntry);
  } else if (plan.daemon.startDaemon) {
    result.daemon = startDetachedDaemon(cliEntry);
  }

  return result;
}
