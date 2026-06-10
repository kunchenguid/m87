import { existsSync } from "node:fs";

import { createDatabase } from "../core/database.js";
import { seedRetentionPolicy } from "../core/retention.js";
import { pluginConfigure, readManifest } from "../host/plugin.js";
import {
  gracefulStopDaemon,
  installManagedService,
  startDetachedDaemon,
} from "../cli/daemon-lifecycle.js";
import {
  ensureStateDir,
  getStatePaths,
  loadConfig,
  saveConfig,
} from "../cli/state.js";

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
    const { stopped, ...service } = await installManagedService(cliEntry);
    result.service = service;
    if (stopped) result.daemon = stopped;
    if (service.status === "stop_failed" || service.status === "unsupported") {
      result.status = service.status;
    }
  } else if (plan.daemon.startDaemon) {
    result.daemon = startDetachedDaemon(cliEntry);
  } else if (plan.daemon.stopDaemon) {
    result.daemon = await gracefulStopDaemon();
  }

  return result;
}
