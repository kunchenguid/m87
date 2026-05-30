#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import yaml from "js-yaml";

import pkg from "../../package.json" with { type: "json" };

import {
  detectAgentSpecs,
  resolveAgentDetection,
  resolveEffectiveAgentSpec,
} from "../agent/detect.js";
import {
  applyLoginShellEnv,
  shouldSkipLoginShellEnv,
} from "../agent/shellenv.js";
import { createControlServer, sendControl } from "../core/control.js";
import { createDatabase } from "../core/database.js";
import { makeEvent } from "../core/event.js";
import { createLogger } from "../core/log.js";
import { deadLetterCount, enqueue, pendingCount } from "../core/queue.js";
import { selectPluginsDueForSync } from "../core/scheduler.js";
import {
  pluginConfigure,
  pluginDoctor,
  pluginPreviewAction,
  readManifest,
} from "../host/plugin.js";
import { getStatePaths, loadConfig, saveConfig } from "./state.js";
import { openRuntime, runOnce } from "./runtime.js";
import { getServicePlan, isServiceDryRun } from "./service.js";
import { compareSemver, fetchLatestVersion, isUpdateDryRun } from "./update.js";
import { recommendationDetail } from "../core/views.js";
import { renderInboxView } from "../tui/render.js";
import { applyInitPlan, initializeCoreState } from "../setup/init-apply.js";
import {
  buildInitApplyPlan,
  defaultInitSelections,
  validateInitSelections,
} from "../setup/init-model.js";

const CLI_ENTRY = fileURLToPath(import.meta.url);

// Resolve the bundled `plugins/` dir by walking up from this module. Works
// whether running from source (src/cli/index.js) or the bundle (dist/cli.js),
// since the relative depth differs between the two.
function findPluginsDir() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "plugins", "mock", "m87-src-mock.js"))) {
      return join(dir, "plugins");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins");
}

const pluginsDir = findPluginsDir();
const bundledPluginPaths = {
  mock: join(pluginsDir, "mock", "m87-src-mock.js"),
  github: join(pluginsDir, "github", "m87-src-github.js"),
  gmail: join(pluginsDir, "gmail", "m87-src-gmail.js"),
};

const out = (obj) => {
  process.stdout.write(yaml.dump(obj));
};
const fail = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exitCode = code;
};
const failUsage = (msg) => fail(msg, 2);

// The daemon is the sole loop/consumer. The CLI only ever appends events
// (writes) and reads projections - it never drains the queue itself.
function daemonPid() {
  const { pidPath } = getStatePaths();
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

// Guard for mutating commands: a live daemon must be processing the queue.
function requireDaemon() {
  const pid = daemonPid();
  if (!pid) {
    fail("daemon not running; start it with `m87 daemon start`");
    return null;
  }
  return pid;
}

function openDb() {
  return createDatabase(getStatePaths().dbPath);
}

// Bounded, read-only poll of a projection so a writer command can report the
// daemon's result without ever consuming the queue. Returns the predicate's
// truthy value, or null on timeout.
async function pollFor(
  predicate,
  { timeoutMs = 15000, intervalMs = 150 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Ask the running daemon to sync immediately over the control channel. Returns
// false if the daemon can't be reached (then the caller falls back to a short
// poll, since the daemon syncs on its own tick regardless).
async function requestDaemonSync() {
  try {
    const reply = await sendControl(
      getStatePaths().controlAddress,
      { cmd: "sync" },
      { timeoutMs: 3000 },
    );
    return Boolean(reply && reply.ok);
  } catch {
    return false;
  }
}

function parseConfigPairs(pairs = []) {
  const config = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      config[key] = JSON.parse(raw);
    } catch {
      config[key] = raw;
    }
  }
  return config;
}

const program = new Command();
program
  .name("m87")
  .description("Local-first review queue (event-driven)")
  .version(pkg.version);

// --- default: the inbox TUI (interactive on a TTY, one-shot render otherwise) -
program.action(async () => {
  const { dbPath } = getStatePaths();
  if (!existsSync(dbPath)) {
    return fail("not initialized; run `m87 init` first");
  }
  const config = loadConfig();
  const agentTarget = resolveEffectiveAgentSpec(config) ?? "none";
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { launchInteractiveTui } = await import("../tui/app.js");
    const db = openDb();
    // The TUI is a reader: it tails the log and enqueues decision events for
    // the daemon. It never drives the loop. `daemonPid` lets it act only when
    // the daemon is running.
    await launchInteractiveTui({ db, agentTarget, daemonPid });
    db.close();
    return;
  }
  const db = createDatabase(dbPath);
  process.stdout.write(`${renderInboxView(db, { agentTarget })}\n`);
  db.close();
});

// --- init ------------------------------------------------------------------
const initHeadlessFlagNames = new Set([
  "--yes",
  "--agent",
  "--plugin",
  "--github-repo",
  "--github-username",
  "--github-owned",
  "--github-public-owned",
  "--github-public-starred",
  "--github-authored-external",
  "--install-service",
  "--no-install-service",
  "--start-daemon",
]);

function hasRawFlag(flag) {
  return process.argv.includes(flag);
}

function hasHeadlessInitFlags() {
  return process.argv.some(
    (arg) =>
      initHeadlessFlagNames.has(arg) ||
      [...initHeadlessFlagNames].some((flag) => arg.startsWith(`${flag}=`)),
  );
}

function normalizeOptionArray(value) {
  if (Array.isArray(value))
    return value.flatMap((entry) => normalizeOptionArray(entry));
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function initSetupContext() {
  const { stateDir, dbPath, configPath } = getStatePaths();
  const detectedAgents = detectAgentSpecs();
  const servicePlan = getServicePlan(stateDir, CLI_ENTRY);
  return {
    stateDir,
    dbExists: existsSync(dbPath),
    configExists: existsSync(configPath),
    detectedAgents,
    detectedAgent: detectedAgents[0] ?? null,
    serviceManager: servicePlan?.manager ?? null,
  };
}

function initSelectionsFromOptions(options = {}) {
  const selections = defaultInitSelections({ currentStep: "agent" });
  if (options.agent === "auto") {
    selections.agentMode = "auto";
    selections.customAgent = "";
  } else if (typeof options.agent === "string" && options.agent.length > 0) {
    selections.agentMode = "custom";
    selections.customAgent = options.agent;
  }

  const githubRepos = normalizeOptionArray(options.githubRepo);
  const hasGithubScopeFlag =
    githubRepos.length > 0 ||
    Boolean(options.githubOwned) ||
    Boolean(options.githubPublicOwned) ||
    Boolean(options.githubPublicStarred) ||
    Boolean(options.githubAuthoredExternal);

  if (options.plugin === "github" || hasGithubScopeFlag) {
    selections.source = "github";
  } else if (options.plugin === "skip" || options.plugin === "none") {
    selections.source = "skip";
  } else if (typeof options.plugin === "string" && options.plugin.length > 0) {
    selections.source = options.plugin;
  }

  if (githubRepos.length > 0) {
    selections.githubScope = "explicit";
    selections.githubRepos = githubRepos;
    selections.githubRepoInput = githubRepos.join(", ");
  } else if (options.githubOwned) {
    selections.githubScope = "owned";
  } else if (options.githubPublicOwned) {
    selections.githubScope = "public_owned";
  } else if (options.githubPublicStarred) {
    selections.githubScope = "public_starred";
  } else if (options.githubAuthoredExternal) {
    selections.githubScope = "authored_external";
  }

  if (typeof options.githubUsername === "string") {
    selections.githubUsername = options.githubUsername;
  }

  if (hasRawFlag("--no-install-service")) {
    selections.installService = false;
    selections.startDaemon = false;
  } else if (hasRawFlag("--install-service")) {
    selections.installService = true;
    selections.startDaemon = true;
  }
  if (options.startDaemon) {
    selections.startDaemon = true;
  }
  return selections;
}

async function applyInitSelections(selections, context, mode) {
  const errors = validateInitSelections(selections);
  if (errors.length > 0) {
    failUsage(errors.join("\n"));
    return;
  }
  const plan = buildInitApplyPlan(selections, context);
  const result = await applyInitPlan(plan, {
    bundledPluginPaths,
    cliEntry: CLI_ENTRY,
  });
  result.mode = mode;
  out(result);
}

// Graceful, cross-platform daemon stop, shared with `m87 daemon stop`.
async function gracefulStopDaemon() {
  const { pidPath, controlAddress } = getStatePaths();
  if (!existsSync(pidPath)) return { status: "not_running" };
  const pid = Number(readFileSync(pidPath, "utf8"));
  try {
    await sendControl(controlAddress, { cmd: "stop" }, { timeoutMs: 3000 });
  } catch {
    // Control channel unreachable (stale pidfile, or a pre-socket daemon):
    // fall back to a signal. This is forcible on Windows.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return { status: "not_running" };
    }
  }
  const gone = await pollFor(() => (isAlive(pid) ? null : true), {
    timeoutMs: 8000,
    intervalMs: 100,
  });
  return { status: gone ? "stopped" : "stopping", pid };
}

program
  .command("init")
  .description("Initialize the local state directory and database")
  .option("--yes", "apply setup defaults without opening the wizard")
  .option("--wizard", "force the interactive setup wizard")
  .option("--agent <target>", "auto or an explicit acp:<target>")
  .option("--plugin <plugin>", "github or skip")
  .option("--github-repo <repo...>", "GitHub owner/repo to sync")
  .option("--github-username <login>", "GitHub login for discovered scopes")
  .option("--github-owned", "sync repositories owned by the GitHub user")
  .option("--github-public-owned", "sync public repositories owned by the user")
  .option(
    "--github-public-starred",
    "sync public owned repositories that the user has starred",
  )
  .option(
    "--github-authored-external",
    "sync issues and pull requests authored outside configured repositories",
  )
  .option("--install-service", "start now and launch at login")
  .option("--no-install-service", "do not start in the background yet")
  .option("--start-daemon", "start now for this session only")
  .action(async (options) => {
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (options.wizard && !tty) {
      return failUsage("--wizard requires an interactive terminal");
    }

    const context = initSetupContext();
    const wantsWizard =
      options.wizard || (tty && !options.yes && !hasHeadlessInitFlags());
    if (wantsWizard) {
      const { launchInitWizardTui } = await import("../setup/init-app.js");
      const selections = await launchInitWizardTui({
        context,
        initialSelections: { source: "github" },
      });
      if (!selections) {
        return out({ status: "cancelled" });
      }
      return applyInitSelections(selections, context, "wizard");
    }

    if (options.yes || hasHeadlessInitFlags()) {
      const selections = initSelectionsFromOptions(options);
      return applyInitSelections(selections, context, "headless");
    }

    const { stateDir } = initializeCoreState();
    out({ status: "initialized", state_dir: stateDir });
  });

// --- status ----------------------------------------------------------------
program
  .command("status")
  .description("Show agent, plugins, queue, and inbox status")
  .action(() => {
    const config = loadConfig();
    const detection = resolveAgentDetection(config);
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const plugins = db
      .prepare("select id, status, last_sync_at, last_error from plugins")
      .all();
    const byState = db
      .prepare("select local_state, count(*) c from items group by local_state")
      .all();
    out({
      agent: { target: detection.spec ?? "none", source: detection.source },
      plugins,
      items: Object.fromEntries(byState.map((r) => [r.local_state, r.c])),
      queue: { pending: pendingCount(db), dead_letter: deadLetterCount(db) },
      events: db.prepare("select count(*) c from events").get().c,
    });
    db.close();
  });

// --- plugin ----------------------------------------------------------------
const plugin = program.command("plugin").description("Manage source plugins");

plugin
  .command("add <pluginId>")
  .option("--config <pair...>", "configuration key=value pairs")
  .description("Install a bundled source plugin")
  .action(async (pluginId, options) => {
    const binaryPath = bundledPluginPaths[pluginId];
    if (!binaryPath || !existsSync(binaryPath)) {
      return fail(`unknown plugin: ${pluginId}`);
    }
    const manifest = await readManifest(binaryPath);
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const now = new Date().toISOString();
    const config = options.config ? parseConfigPairs(options.config) : {};
    db.prepare(
      `insert or replace into plugins (id, binary_path, version, protocol_version, manifest_json, config_json, status, installed_at)
       values (?,?,?,?,?,?, 'active', ?)`,
    ).run(
      manifest.plugin.id,
      binaryPath,
      manifest.plugin.version,
      manifest.protocol_version,
      JSON.stringify(manifest),
      JSON.stringify(config),
      now,
    );
    db.close();
    out({ status: "installed", plugin: manifest.plugin });
  });

plugin
  .command("list")
  .description("List installed and bundled plugins")
  .action(() => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const installed = db
      .prepare("select id, version, status, last_sync_at from plugins")
      .all();
    db.close();
    out({ installed, bundled: Object.keys(bundledPluginPaths) });
  });

plugin
  .command("configure <pluginId>")
  .option("--config <pair...>", "configuration key=value pairs")
  .description("Configure an installed plugin")
  .action(async (pluginId, options) => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const record = db.prepare("select * from plugins where id=?").get(pluginId);
    if (!record) {
      db.close();
      return fail(`plugin not installed: ${pluginId}`);
    }
    const config = options.config ? parseConfigPairs(options.config) : {};
    const response = await pluginConfigure(record.binary_path, config);
    db.prepare(
      "update plugins set config_json=?, status='active', last_error=null where id=?",
    ).run(JSON.stringify(config), pluginId);
    db.close();
    out({ status: "configured", display_name: response.display_name });
  });

plugin
  .command("sync <pluginId>")
  .description("Ask the daemon to sync a plugin now")
  .action(async (pluginId) => {
    const pid = requireDaemon();
    if (!pid) return;
    const db = openDb();
    const record = db
      .prepare("select id, last_sync_at from plugins where id=?")
      .get(pluginId);
    if (!record) {
      db.close();
      return fail(`plugin not installed: ${pluginId}`);
    }
    const before = record.last_sync_at;
    const nudged = await requestDaemonSync();
    const synced = await pollFor(
      () => {
        const r = db
          .prepare("select last_sync_at from plugins where id=?")
          .get(pluginId);
        return r && r.last_sync_at !== before ? r.last_sync_at : null;
      },
      { timeoutMs: nudged ? 15000 : 2000 },
    );
    db.close();
    out({
      status: synced ? "synced" : "sync_requested",
      plugin: pluginId,
      ...(synced ? { last_sync_at: synced } : {}),
    });
  });

plugin
  .command("doctor")
  .description("Health-check installed plugins")
  .action(async () => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const records = db.prepare("select * from plugins").all();
    const results = [];
    for (const record of records) {
      try {
        const doctor = await pluginDoctor(
          record.binary_path,
          JSON.parse(record.config_json ?? "{}"),
        );
        results.push({
          id: record.id,
          status: doctor.status,
          warnings: doctor.warnings,
        });
      } catch (err) {
        results.push({
          id: record.id,
          status: "error",
          error: String(err.message),
        });
      }
    }
    db.close();
    out({ plugins: results });
  });

// --- sync (all plugins) ----------------------------------------------------
program
  .command("sync")
  .description("Ask the daemon to sync + triage all active plugins now")
  .action(async () => {
    const pid = requireDaemon();
    if (!pid) return;
    const db = openDb();
    const before = db.prepare("select count(*) c from events").get().c;
    const nudged = await requestDaemonSync();
    // wait for the event log to advance (sync produced facts) or settle
    await pollFor(
      () => {
        const after = db.prepare("select count(*) c from events").get().c;
        return after > before ? after : null;
      },
      { timeoutMs: nudged ? 8000 : 2000 },
    );
    out({
      status: nudged ? "synced" : "sync_requested",
      items: db.prepare("select count(*) c from items").get().c,
      recommendations: db
        .prepare(
          "select count(*) c from recommendations where superseded_at is null",
        )
        .get().c,
    });
    db.close();
  });

// --- inbox: list / preview / approve / dismiss / snooze / mark-handled -----
function listInbox(db) {
  return db
    .prepare(
      `select r.id as recommendation_id, r.summary, i.id as item_id, i.title, i.url,
              i.local_state, i.attention_priority_hint
         from recommendations r join items i on i.id = r.item_id
        where r.superseded_at is null
          and (i.local_state in ('recommended','action_error')
               or (i.local_state='snoozed' and i.snoozed_until <= ?))
        order by case i.attention_priority_hint when 'urgent' then 0 else 1 end, i.activity_at desc`,
    )
    .all(new Date().toISOString());
}

program
  .command("list")
  .description("List the active review inbox")
  .action(() => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const inbox = listInbox(db).map((row) => {
      const options = db
        .prepare(
          "select id, position, title, confidence from recommendation_options where recommendation_id=? order by position",
        )
        .all(row.recommendation_id);
      return { ...row, options };
    });
    db.close();
    out({ inbox });
  });

function getRecTarget(db, recommendationId, optionSelector) {
  const rec = db
    .prepare(
      "select * from recommendations where id=? and superseded_at is null",
    )
    .get(recommendationId);
  if (!rec) return { error: "recommendation not found or superseded" };
  const options = db
    .prepare(
      "select * from recommendation_options where recommendation_id=? order by position",
    )
    .all(recommendationId);
  let option;
  if (optionSelector !== undefined && optionSelector !== null) {
    option = options.find(
      (o) =>
        o.id === optionSelector ||
        String(o.position) === String(optionSelector),
    );
  } else if (options.length === 1) {
    option = options[0];
  }
  if (!option)
    return {
      error: "option required",
      options: options.map((o) => ({
        id: o.id,
        position: o.position,
        title: o.title,
      })),
    };
  const item = db.prepare("select * from items where id=?").get(rec.item_id);
  const pluginRecord = db
    .prepare("select * from plugins where id=?")
    .get(item.plugin_id);
  return { rec, option, item, pluginRecord };
}

function optionActions(option) {
  return JSON.parse(option.actions_json ?? "[]");
}

function manifestSafety(pluginRecord, actionType) {
  const manifest = JSON.parse(pluginRecord.manifest_json ?? "{}");
  const def = (manifest.action_types ?? []).find((a) => a.type === actionType);
  return def?.safety ?? "safe";
}

program
  .command("preview <recommendationId>")
  .option("--option <selector>", "option id or position")
  .description("Preview what approving an option would do (the gate)")
  .action(async (recommendationId, options) => {
    const { dbPath, stateDir } = getStatePaths();
    const db = createDatabase(dbPath);
    const target = getRecTarget(db, recommendationId, options.option);
    if (target.error) {
      db.close();
      return fail(yaml.dump(target).trim());
    }
    const config = JSON.parse(target.pluginRecord.config_json ?? "{}");
    const previews = [];
    for (const action of optionActions(target.option)) {
      const safety = manifestSafety(target.pluginRecord, action.action_type);
      const preview = await pluginPreviewAction(
        target.pluginRecord.binary_path,
        {
          config,
          item_external_id: target.item.external_id,
          action,
          approval_id: `approval-${recommendationId}`,
          idempotency_key: `${recommendationId}:${action.id}`,
        },
      );
      db.prepare(
        `insert or replace into action_previews
          (id, recommendation_id, option_id, item_id, plugin_id, action_id, action_type, required, depends_on_json, safety, validation_json, preview_json, request_json, edited_actions_json, created_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `${recommendationId}:${action.id}`,
        recommendationId,
        target.option.id,
        target.item.id,
        target.pluginRecord.id,
        action.id,
        action.action_type,
        action.required ? 1 : 0,
        JSON.stringify(action.depends_on ?? []),
        safety,
        "{}",
        JSON.stringify(preview),
        JSON.stringify({ action }),
        "[]",
        new Date().toISOString(),
      );
      previews.push({
        action_id: action.id,
        action_type: action.action_type,
        safety,
        summary: preview.summary,
        preview: preview.preview,
      });
    }
    db.close();
    out({
      status: "previewed",
      recommendation_id: recommendationId,
      option_id: target.option.id,
      previews,
    });
    void stateDir;
  });

program
  .command("approve <recommendationId>")
  .option("--option <selector>", "option id or position")
  .option("--confirm", "confirm external-write actions")
  .option("--confirm-destructive", "confirm destructive actions")
  .description("Approve an option: the one human gate (emits approval.created)")
  .action(async (recommendationId, options) => {
    const pid = requireDaemon();
    if (!pid) return;
    const db = openDb();
    const target = getRecTarget(db, recommendationId, options.option);
    if (target.error) {
      db.close();
      return fail(yaml.dump(target).trim());
    }
    const actions = optionActions(target.option);
    const hasExternalWrite = actions.some(
      (a) =>
        manifestSafety(target.pluginRecord, a.action_type) === "external_write",
    );
    const hasDestructive = actions.some(
      (a) =>
        manifestSafety(target.pluginRecord, a.action_type) === "destructive",
    );
    if (hasExternalWrite && !options.confirm) {
      db.close();
      out({
        status: "confirmation_required",
        reason: "option performs external writes; re-run with --confirm",
      });
      process.exitCode = 1;
      return;
    }
    if (hasDestructive && !options.confirmDestructive) {
      db.close();
      out({
        status: "destructive_confirmation_required",
        reason: "re-run with --confirm-destructive",
      });
      process.exitCode = 1;
      return;
    }
    enqueue(
      db,
      makeEvent({
        actor: "user",
        entity: "approval",
        lifecycle: "created",
        item_id: target.item.id,
        payload: {
          type: "approved",
          approval_id: `approval-${recommendationId}`,
          recommendation_id: recommendationId,
          option_id: target.option.id,
          decision: "approved",
          idempotency_key: `approval-${recommendationId}`,
        },
        dedup_key: `approval-${recommendationId}`,
      }),
      { lane: "interactive" },
    );
    // The daemon processes the approval. If the option does real work, wait for
    // a terminal item state; otherwise just confirm the approval landed.
    const approvalId = `approval-${recommendationId}`;
    const willSettle =
      actions.length > 0 || Boolean(target.option.automation_json);
    const settled = await pollFor(() => {
      const it = db
        .prepare("select local_state from items where id=?")
        .get(target.item.id);
      if (
        it &&
        (it.local_state === "handled" || it.local_state === "action_error")
      ) {
        return it.local_state;
      }
      if (!willSettle) {
        const ap = db
          .prepare("select 1 from approvals where id=?")
          .get(approvalId);
        return ap ? "approved_pending" : null;
      }
      return null;
    });
    const item = db
      .prepare("select local_state from items where id=?")
      .get(target.item.id);
    out({
      status: settled ? "approved" : "queued",
      recommendation_id: recommendationId,
      item_state: item.local_state,
    });
    db.close();
  });

// Enqueue a user decision event and wait (read-only) for the daemon to fold it
// into the item's local_state. Requires a live daemon.
async function userItemDecision(itemId_, type, localState, extra = {}) {
  const pid = requireDaemon();
  if (!pid) return false;
  const db = openDb();
  const item = db.prepare("select id from items where id=?").get(itemId_);
  if (!item) {
    db.close();
    fail(`item not found: ${itemId_}`);
    return false;
  }
  enqueue(
    db,
    makeEvent({
      actor: "user",
      entity: "item",
      lifecycle: type === "marked_handled" ? "closed" : "updated",
      item_id: itemId_,
      payload: { type, local_state: localState, ...extra },
    }),
    { lane: "interactive" },
  );
  const applied = await pollFor(() => {
    const r = db
      .prepare("select local_state from items where id=?")
      .get(itemId_);
    return r && r.local_state === localState ? true : null;
  });
  db.close();
  return applied ? "applied" : "queued";
}

program
  .command("dismiss <itemId>")
  .description("Dismiss an item")
  .action(async (id) => {
    const r = await userItemDecision(id, "dismissed", "dismissed");
    if (r)
      out({ status: r === "applied" ? "dismissed" : "queued", item_id: id });
  });

program
  .command("mark-handled <itemId>")
  .description("Mark an item handled")
  .action(async (id) => {
    const r = await userItemDecision(id, "marked_handled", "handled");
    if (r) out({ status: r === "applied" ? "handled" : "queued", item_id: id });
  });

program
  .command("snooze <itemId> <duration>")
  .description("Snooze an item until later (e.g. 1d, 4h)")
  .action(async (id, duration) => {
    const until = computeSnoozeUntil(duration);
    const r = await userItemDecision(id, "snoozed", "snoozed", {
      snoozed_until: until,
    });
    if (r)
      out({
        status: r === "applied" ? "snoozed" : "queued",
        item_id: id,
        until,
      });
  });

function computeSnoozeUntil(duration) {
  const m = /^(\d+)([smhd])$/.exec(duration);
  const ms = m
    ? Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2]]
    : 8.64e7;
  return new Date(Date.now() + ms).toISOString();
}

// --- triage / rerun --------------------------------------------------------
program
  .command("triage <itemId>")
  .description("Ask the daemon to triage one new item")
  .action(async (id) => {
    const pid = requireDaemon();
    if (!pid) return;
    const db = openDb();
    const item = db.prepare("select * from items where id=?").get(id);
    if (!item) {
      db.close();
      return fail(`item not found: ${id}`);
    }
    if (item.local_state !== "new") {
      db.close();
      out({
        status: "not_new",
        item_id: id,
        local_state: item.local_state,
        hint: `use \`m87 rerun ${id}\` to re-triage`,
      });
      process.exitCode = 1;
      return;
    }
    if (!resolveEffectiveAgentSpec(loadConfig())) {
      db.close();
      out({ status: "agent_unconfigured", item_id: id });
      process.exitCode = 1;
      return;
    }
    // re-emit an item.updated so the daemon's attentionPolicy auto-triages it
    enqueue(
      db,
      makeEvent({
        actor: "user",
        entity: "item",
        lifecycle: "updated",
        item_id: id,
        attention: { should_surface: true },
        payload: { type: "retriage", local_state: "new" },
      }),
      { lane: "interactive" },
    );
    const done = await pollFor(() => {
      const r = db.prepare("select local_state from items where id=?").get(id);
      return r && r.local_state === "recommended" ? r.local_state : null;
    });
    const after = db
      .prepare("select local_state from items where id=?")
      .get(id);
    out({
      status: done ? "triaged" : "queued",
      item_id: id,
      local_state: after.local_state,
    });
    db.close();
  });

program
  .command("rerun <itemId>")
  .option("--instructions <text>", "extra instructions for the agent")
  .description("Supersede the current recommendation and re-triage an item")
  .action(async (id, options) => {
    const pid = requireDaemon();
    if (!pid) return;
    const db = openDb();
    const item = db.prepare("select * from items where id=?").get(id);
    if (!item) {
      db.close();
      return fail(`item not found: ${id}`);
    }
    if (!resolveEffectiveAgentSpec(loadConfig())) {
      db.close();
      out({ status: "agent_unconfigured", item_id: id });
      process.exitCode = 1;
      return;
    }
    const rec = db
      .prepare(
        "select id from recommendations where item_id=? and superseded_at is null",
      )
      .get(id);
    if (rec) {
      enqueue(
        db,
        makeEvent({
          actor: "user",
          entity: "recommendation",
          lifecycle: "closed",
          item_id: id,
          payload: { type: "rerun", recommendation_id: rec.id },
        }),
        { lane: "interactive" },
      );
    }
    // reset to 'new' so the daemon's attentionPolicy re-triages; the
    // instructions ride in the payload and are forwarded to the triage effect.
    enqueue(
      db,
      makeEvent({
        actor: "user",
        entity: "item",
        lifecycle: "updated",
        item_id: id,
        attention: { should_surface: true },
        payload: {
          type: "reset_for_rerun",
          local_state: "new",
          rerun_instructions: options.instructions ?? null,
        },
      }),
      { lane: "interactive" },
    );
    const priorRecId = rec?.id;
    const done = await pollFor(() => {
      const fresh = db
        .prepare(
          "select id from recommendations where item_id=? and superseded_at is null",
        )
        .get(id);
      return fresh && fresh.id !== priorRecId ? fresh.id : null;
    });
    const after = db
      .prepare("select local_state from items where id=?")
      .get(id);
    out({
      status: done ? "reran" : "queued",
      item_id: id,
      local_state: after.local_state,
    });
    db.close();
  });

// --- view / open / copy-handoff --------------------------------------------
program
  .command("view <itemId>")
  .description("Show one item and its recommendation detail")
  .action((id) => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const item = db.prepare("select * from items where id=?").get(id);
    if (!item) {
      db.close();
      return fail(`item not found: ${id}`);
    }
    const rec = db
      .prepare(
        "select * from recommendations where item_id=? and superseded_at is null",
      )
      .get(id);
    const detail = rec ? recommendationDetail(db, rec.id) : null;
    const agentRun = db
      .prepare(
        "select agent_spec, status, tokens_in, tokens_out, completed_at from agent_runs where item_id=? order by started_at desc limit 1",
      )
      .get(id);
    const approvals = db
      .prepare("select id, decision, created_at from approvals where item_id=?")
      .all(id);
    const actions = db
      .prepare(
        "select action_id, action_type, status, error from action_results where item_id=?",
      )
      .all(id);
    db.close();
    out({
      status: "found",
      item: {
        id: item.id,
        title: item.title,
        item_type: item.item_type,
        actor: item.actor,
        plugin: item.plugin_id,
        state: item.state,
        local_state: item.local_state,
        activity_at: item.activity_at,
        attention_reason: item.attention_reason,
        waiting_on: item.waiting_on,
        url: item.url,
      },
      recommendation: detail
        ? {
            id: detail.recommendation.id,
            summary: detail.recommendation.summary,
            options: detail.options.map((o) => ({
              id: o.id,
              title: o.title,
              confidence: o.confidence,
              actions: o.actions.length,
              automation: Boolean(o.automation),
            })),
          }
        : null,
      agent_run: agentRun ?? null,
      approvals,
      actions,
    });
  });

program
  .command("open <itemId>")
  .description("Print the item's source URL")
  .action((id) => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const item = db.prepare("select id, url from items where id=?").get(id);
    db.close();
    if (!item) return fail(`item not found: ${id}`);
    out({ status: "found", item_id: item.id, url: item.url });
  });

program
  .command("copy-handoff <itemId>")
  .description("Print a copyable agent handoff prompt for one item")
  .action((id) => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const item = db.prepare("select * from items where id=?").get(id);
    if (!item) {
      db.close();
      return fail(`item not found: ${id}`);
    }
    const ctx = db
      .prepare(
        "select agent_context_json, human_context_json from prompt_contexts where item_id=? and deleted_at is null order by created_at desc limit 1",
      )
      .get(id);
    db.close();
    const handoff = [
      `Item: ${item.title}`,
      `Source: ${item.url}`,
      `Why it surfaced: ${item.attention_reason}`,
      ctx
        ? `Context: ${ctx.agent_context_json}`
        : "Context: (none stored; run `m87 triage`)",
    ].join("\n");
    out({ status: "found", item_id: id, handoff_prompt: handoff });
  });

// --- job -------------------------------------------------------------------
const job = program.command("job").description("Inspect automation jobs");
job
  .command("list")
  .description("List automation jobs")
  .action(() => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    out({
      jobs: db
        .prepare(
          "select id, item_id, kind, status, phase, updated_at from jobs order by created_at desc",
        )
        .all(),
    });
    db.close();
  });
job
  .command("view <jobId>")
  .description("View one automation job")
  .action((jobId) => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const j = db.prepare("select * from jobs where id=?").get(jobId);
    db.close();
    if (!j) return fail(`job not found: ${jobId}`);
    out({ job: { ...j, metadata: JSON.parse(j.metadata_json) } });
  });
job
  .command("attach <jobId>")
  .description("Re-check for a waiting fix job's pull request")
  .action(async (jobId) => {
    const pid = requireDaemon();
    if (!pid) return;
    const db = openDb();
    const j = db.prepare("select * from jobs where id=?").get(jobId);
    if (!j) {
      db.close();
      return fail(`job not found: ${jobId}`);
    }
    if (j.phase !== "waiting_for_pr") {
      db.close();
      return fail(
        `job ${jobId} is not waiting for a PR (status=${j.status}, phase=${j.phase})`,
      );
    }
    enqueue(
      db,
      makeEvent({
        actor: "user",
        entity: "job",
        lifecycle: "updated",
        item_id: j.item_id,
        payload: { type: "attach_requested", job_id: jobId },
      }),
      { lane: "interactive" },
    );
    const done = await pollFor(() => {
      const r = db
        .prepare("select status, metadata_json from jobs where id=?")
        .get(jobId);
      return r && r.status === "succeeded" ? r : null;
    });
    db.close();
    if (done) {
      out({
        status: "pr_opened",
        job_id: jobId,
        pr_url: JSON.parse(done.metadata_json ?? "{}").pr_url ?? null,
      });
    } else {
      out({ status: "waiting_for_pr", job_id: jobId });
    }
  });

// --- audit -----------------------------------------------------------------
const audit = program
  .command("audit")
  .description("Inspect the action audit trail");
audit
  .command("export")
  .description("Export the action audit trail")
  .action(() => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    out({
      audit: db
        .prepare(
          "select id, approval_id, item_id, action_type, status, completed_at from action_results order by started_at",
        )
        .all(),
    });
    db.close();
  });
audit
  .command("receipt <approvalId>")
  .description("Show a receipt for an approval")
  .action((approvalId) => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const approval = db
      .prepare("select * from approvals where id=?")
      .get(approvalId);
    if (!approval) {
      db.close();
      return fail(`approval not found: ${approvalId}`);
    }
    const actions = db
      .prepare(
        "select action_id, action_type, status, error from action_results where approval_id=?",
      )
      .all(approvalId);
    db.close();
    out({
      approval: {
        id: approval.id,
        item_id: approval.item_id,
        decision: approval.decision,
        created_at: approval.created_at,
      },
      actions,
    });
  });

// --- retention -------------------------------------------------------------
program
  .command("retention")
  .description("Manage retention")
  .command("cleanup")
  .description("Delete expired prompt contexts")
  .action(() => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const now = new Date().toISOString();
    const info = db
      .prepare(
        "update prompt_contexts set deleted_at=? where expires_at is not null and expires_at <= ? and deleted_at is null",
      )
      .run(now, now);
    db.close();
    out({ status: "cleaned", deleted: info.changes });
  });

// --- state -----------------------------------------------------------------
const state = program
  .command("state")
  .description("Portable state export/import");
state
  .command("export")
  .description("Export portable state (secrets redacted)")
  .action(() => {
    const { dbPath } = getStatePaths();
    const db = createDatabase(dbPath);
    const plugins = db.prepare("select id, version, status from plugins").all();
    db.close();
    out({ version: 2, plugins, config: redactConfig(loadConfig()) });
  });
function redactConfig(config) {
  return JSON.parse(
    JSON.stringify(config, (k, v) =>
      /secret|token|key|auth|password/i.test(k) ? "[redacted]" : v,
    ),
  );
}
state
  .command("import <file>")
  .description("Import portable plugin + agent config (non-secret only)")
  .action(async (file) => {
    let snapshot;
    try {
      snapshot = yaml.load(await readFile(file, "utf8"));
    } catch (err) {
      return fail(`invalid import file: ${err.message}`);
    }
    let imported = 0;
    if (snapshot && typeof snapshot.config === "object") {
      const config = loadConfig();
      for (const key of [
        "agent",
        "poll_interval",
        "acp_registry_overrides",
        "plugins",
      ]) {
        if (snapshot.config[key] !== undefined)
          config[key] = snapshot.config[key];
      }
      saveConfig(config);
    }
    if (Array.isArray(snapshot?.plugins)) {
      const { dbPath } = getStatePaths();
      const db = createDatabase(dbPath);
      for (const p of snapshot.plugins) {
        const binaryPath = bundledPluginPaths[p.id];
        if (!binaryPath || !existsSync(binaryPath)) continue;
        const manifest = await readManifest(binaryPath);
        db.prepare(
          `insert or replace into plugins (id, binary_path, version, protocol_version, manifest_json, config_json, status, installed_at)
           values (?,?,?,?,?, coalesce((select config_json from plugins where id=?), '{}'), 'active', ?)`,
        ).run(
          manifest.plugin.id,
          binaryPath,
          manifest.plugin.version,
          manifest.protocol_version,
          JSON.stringify(manifest),
          manifest.plugin.id,
          new Date().toISOString(),
        );
        imported += 1;
      }
      db.close();
    }
    out({ status: "imported", plugins: imported });
  });

// --- daemon ----------------------------------------------------------------
const daemon = program.command("daemon").description("Manage the local daemon");
daemon
  .command("run", { hidden: true })
  .description("Run the daemon loop in the foreground")
  .option("--once", "process the queue once and exit")
  .action(async (options) => {
    // The daemon's stdout/stderr are redirected to daemon.log by `daemon start`
    // (and by the launchd/systemd service), so this logger is the daemon's
    // operational record. onError funnels loop/effect errors into the same file.
    const logger = createLogger();
    const runtime = openRuntime({
      logger,
      onError: (e) =>
        logger.error("loop error", { error: e?.message ?? String(e) }),
    });
    const { pidPath, controlAddress } = getStatePaths();
    if (options.once) {
      writeFileSync(pidPath, String(process.pid));
      await scheduleSync(runtime);
      await runOnce(runtime);
      runtime.db.close();
      cleanupPid(pidPath);
      return;
    }
    const controller = new AbortController();
    let stopping = false;
    // First stop request: graceful abort (the loop stops scheduling and the
    // abort propagates into in-flight effects so the agent subprocess is torn
    // down). Second request: the caller is impatient - exit now.
    const stop = () => {
      if (stopping) {
        process.exit(1);
        return;
      }
      stopping = true;
      controller.abort();
    };
    // Terminal/service signals trigger graceful shutdown on POSIX. Windows has
    // no POSIX signals, so there the control channel's "stop" command is the
    // graceful path (see `m87 daemon stop`).
    process.on("SIGINT", stop);
    if (process.platform !== "win32") {
      process.on("SIGTERM", stop);
      process.on("SIGHUP", stop);
    }
    // The CLI drives the daemon over a local control socket (UDS on POSIX, a
    // named pipe on Windows): "sync" nudges an immediate sync, "stop" requests
    // graceful shutdown. This replaces the POSIX-only SIGUSR1/SIGTERM IPC.
    const control = await createControlServer(controlAddress, async (msg) => {
      if (msg && msg.cmd === "sync") {
        await scheduleSync(runtime);
        return { ok: true };
      }
      if (msg && msg.cmd === "stop") {
        stop();
        return { ok: true };
      }
      if (msg && msg.cmd === "ping") {
        return { ok: true, pid: process.pid };
      }
      return { ok: false, error: `unknown command: ${msg && msg.cmd}` };
    });
    // Advertise liveness only once the control channel is bound, so any client
    // that sees the pidfile can reach us.
    writeFileSync(pidPath, String(process.pid));
    logger.info("daemon started", {
      pid: process.pid,
      poll_interval: runtime.config.poll_interval ?? 300,
    });
    let lastSync = 0;
    try {
      await runtime.loop.runForever({
        signal: controller.signal,
        tickMs: 1000,
        onTick: async () => {
          const interval = (runtime.config.poll_interval ?? 300) * 1000;
          if (Date.now() - lastSync >= interval) {
            lastSync = Date.now();
            await scheduleSync(runtime);
          }
          sweepTtl(runtime.db); // the scheduler owns retention sweeps (plan §4)
        },
      });
    } finally {
      logger.info("daemon stopping", { pid: process.pid });
      control.close();
      // Give aborted effects a brief, bounded window to cancel their agent
      // turns; cap it so a wedged child can never block shutdown.
      await Promise.race([
        runtime.loop.settle(),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
      runtime.db.close();
      cleanupPid(pidPath);
    }
    // Force exit: an abandoned in-flight agent subprocess can keep stdio pipes
    // open and ref the event loop, so we cannot rely on natural drain here.
    process.exit(0);
  });

function cleanupPid(pidPath) {
  try {
    if (
      existsSync(pidPath) &&
      Number(readFileSync(pidPath, "utf8")) === process.pid
    ) {
      rmSync(pidPath);
    }
  } catch {
    // best-effort
  }
}

function sweepTtl(db) {
  const now = new Date().toISOString();
  db.prepare(
    "update prompt_contexts set deleted_at=? where expires_at is not null and expires_at <= ? and deleted_at is null",
  ).run(now, now);
}

async function scheduleSync(runtime) {
  // Active/never-synced plugins, plus any failed plugin whose backoff window
  // has elapsed - so a transient failure self-heals instead of latching off.
  const plugins = selectPluginsDueForSync(runtime.db, new Date().toISOString());
  for (const p of plugins) {
    runtime.loop.launchEffect({ type: "sync", plugin_id: p.id });
  }
}

daemon
  .command("start")
  .description("Start the daemon in the background")
  .action(() => {
    const { pidPath, logPath } = getStatePaths();
    if (existsSync(pidPath) && isAlive(Number(readFileSync(pidPath, "utf8")))) {
      return out({
        status: "already_running",
        pid: Number(readFileSync(pidPath, "utf8")),
      });
    }
    const child = spawnDetachedDaemon(logPath);
    out({ status: "started", pid: child.pid, log: logPath });
  });

daemon
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    out(await gracefulStopDaemon());
  });

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningDaemonPid() {
  const { pidPath } = getStatePaths();
  if (!existsSync(pidPath)) {
    return null;
  }
  const pid = Number(readFileSync(pidPath, "utf8"));
  return Number.isInteger(pid) && isAlive(pid) ? pid : null;
}

function spawnDetachedDaemon(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  let child;
  try {
    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "daemon", "run"],
      { detached: true, stdio: ["ignore", logFd, logFd], env: process.env },
    );
  } finally {
    closeSync(logFd);
  }
  child.unref();
  return child;
}

daemon
  .command("status")
  .description("Show whether the daemon is running")
  .action(() => {
    const pid = runningDaemonPid();
    if (pid !== null) {
      return out({ status: "running", running: true, pid });
    }
    out({ status: "not_running", running: false });
  });

daemon
  .command("restart")
  .description("Restart the background daemon")
  .action(async () => {
    const { logPath, controlAddress } = getStatePaths();
    const pid = runningDaemonPid();
    if (pid !== null) {
      try {
        await sendControl(controlAddress, { cmd: "stop" }, { timeoutMs: 3000 });
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      for (let i = 0; i < 80 && isAlive(pid); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const child = spawnDetachedDaemon(logPath);
    out({
      status: "restarted",
      pid: child.pid,
      log: logPath,
      stopped: pid,
    });
  });

daemon
  .command("install")
  .description("Install the daemon as a managed OS service (start at login)")
  .action(async () => {
    const { stateDir } = getStatePaths();
    const plan = getServicePlan(stateDir, CLI_ENTRY);
    if (!plan) {
      process.exitCode = 1;
      return out({ status: "unsupported", platform: process.platform });
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
    out({
      status: "installed",
      manager: plan.manager,
      label: plan.label,
      unit: plan.unitPath,
      activation,
    });
  });

daemon
  .command("uninstall")
  .description("Remove the managed OS service for the daemon")
  .action(async () => {
    const { stateDir } = getStatePaths();
    const plan = getServicePlan(stateDir, CLI_ENTRY);
    if (!plan) {
      process.exitCode = 1;
      return out({ status: "unsupported", platform: process.platform });
    }
    let installed = true;
    try {
      await access(plan.unitPath, constants.F_OK);
    } catch {
      installed = false;
    }
    if (!installed) return out({ status: "no_op", manager: plan.manager });
    if (!isServiceDryRun()) {
      try {
        execFileSync(plan.deactivate.command, plan.deactivate.args, {
          stdio: "ignore",
          timeout: 10000,
        });
      } catch {
        // best-effort; still remove the unit file
      }
    }
    await rm(plan.unitPath, { force: true });
    out({ status: "uninstalled", manager: plan.manager, label: plan.label });
  });

// --- update ----------------------------------------------------------------
program
  .command("update")
  .description("Check for and install a newer m87 release")
  .option("--check", "only check; never install")
  .action(async (options) => {
    const current = program.version();
    let latest;
    try {
      latest = await fetchLatestVersion();
    } catch (err) {
      process.exitCode = 1;
      return out({ status: "check_failed", current, reason: err.message });
    }
    if (compareSemver(current, latest) >= 0) {
      return out({ status: "up_to_date", current, latest });
    }
    const command = `npm install -g @kunchenguid/m87@${latest}`;
    if (options.check || isUpdateDryRun()) {
      return out({
        status: "update_available",
        current,
        latest,
        command,
        applied: false,
      });
    }
    try {
      execFileSync("npm", ["install", "-g", `m87@${latest}`], {
        stdio: "ignore",
        timeout: 120000,
      });
      out({ status: "updated", current, latest, command, applied: true });
    } catch (err) {
      process.exitCode = 1;
      out({
        status: "update_failed",
        current,
        latest,
        command,
        applied: false,
        reason: err.message,
      });
    }
  });

export function run(argv = process.argv) {
  if (!shouldSkipLoginShellEnv()) {
    applyLoginShellEnv();
  }
  program.parse(argv);
}

// A global `npm install` exposes this file through a bin symlink, so
// process.argv[1] (the symlink) won't equal the resolved module path. Compare
// real paths so the CLI actually runs when invoked as the installed `m87`.
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(process.argv[1]);
if (isMain) {
  run();
}

export { program };
