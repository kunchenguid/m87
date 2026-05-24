import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import pkg from "../../package.json" with { type: "json" };

import {
  createMockAcpTarget,
  startFirstpassDaemon,
  waitFor,
} from "../support/e2e-harness.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(repoRoot, "src", "cli", "index.js");

const RECOMMENDATION = {
  recommendation: {
    summary: "Reply and fix",
    evidence: [],
    options: [
      {
        title: "Reply",
        rationale: "ack",
        confidence: "high",
        waiting_on: "user",
        actions: [
          { id: "a1", action_type: "comment", params: {}, required: true },
        ],
      },
    ],
  },
  usage: { tokens_in: 10 },
};

describe("e2e: restored CLI commands (under a daemon)", () => {
  let homeDir;
  let stateDir;
  let env;
  let target;
  let daemon;

  const firstpass = (...args) =>
    execFileAsync(process.execPath, [CLI, ...args], { env });
  const parse = ({ stdout }) => yaml.load(stdout);
  const localState = (itemId) => {
    const db = new Database(join(stateDir, "firstpass.sqlite"));
    const row = db
      .prepare("select local_state from items where id=?")
      .get(itemId);
    db.close();
    return row?.local_state;
  };

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "firstpass-cmds-"));
    stateDir = join(homeDir, ".firstpass");
    env = {
      ...process.env,
      HOME: homeDir,
      FIRSTPASS_STATE_DIR: stateDir,
      FIRSTPASS_SKIP_SHELLENV: "1",
      FIRSTPASS_AGENT_PROBE_PATH: "",
      FIRSTPASS_SERVICE_DRY_RUN: "1",
    };
    target = await createMockAcpTarget(
      { homeDir, stateDir },
      { response: RECOMMENDATION },
    );
    await firstpass("init");
    writeFileSync(
      join(stateDir, "config.yaml"),
      yaml.dump({
        agent: "acp:claude",
        poll_interval: 1,
        acp_registry_overrides: { claude: target.executablePath },
        plugins: {},
      }),
    );
    await firstpass("plugin", "add", "mock", "--trust");
    daemon = startFirstpassDaemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    await firstpass("sync");
    await waitFor(async () => {
      const listed = parse(await firstpass("list"));
      return listed.inbox.length === 1;
    });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("view shows the item and its recommendation", async () => {
    const v = parse(await firstpass("view", "mock:issue-1"));
    expect(v.status).toBe("found");
    expect(v.item.title).toBe("Crash on empty config");
    expect(v.recommendation.summary).toBe("Reply and fix");
  });

  it("open prints the source url; copy-handoff prints a prompt", async () => {
    expect(parse(await firstpass("open", "mock:issue-1")).url).toBe(
      "mock://issue/1",
    );
    expect(
      parse(await firstpass("copy-handoff", "mock:issue-1")).handoff_prompt,
    ).toContain("Crash on empty config");
  });

  it("rerun supersedes and re-triages with a fresh recommendation", async () => {
    const before = parse(await firstpass("view", "mock:issue-1")).recommendation
      .id;
    const r = parse(
      await firstpass("rerun", "mock:issue-1", "--instructions", "be terse"),
    );
    expect(r.status, daemon.stderr).toBe("reran");
    const after = parse(await firstpass("view", "mock:issue-1")).recommendation
      .id;
    expect(after).not.toBe(before);
  });

  it("mutating commands refuse when the daemon is down", async () => {
    await daemon.stop();
    daemon = undefined;
    const err = await firstpass("dismiss", "mock:issue-1").catch((e) => e);
    expect(err.stderr).toContain("daemon not running");
  });

  it("state export -> import round-trips the plugin set", async () => {
    const file = join(homeDir, "state.yaml");
    const { stdout } = await firstpass("state", "export");
    writeFileSync(file, stdout);
    const imported = parse(await firstpass("state", "import", file));
    expect(imported.status).toBe("imported");
    expect(imported.plugins).toBe(1);
  });

  it("daemon status reports the running daemon", async () => {
    const status = parse(await firstpass("daemon", "status"));
    expect(status.running).toBe(true);
    expect(typeof status.pid).toBe("number");
  });

  it("daemon install/uninstall manage a service unit (dry run)", async () => {
    const installed = parse(await firstpass("daemon", "install"));
    expect(installed.status).toBe("installed");
    expect(["launchd", "systemd", "schtasks"]).toContain(installed.manager);
    expect(installed.activation).toBe("skipped_dry_run");
    const uninstalled = parse(await firstpass("daemon", "uninstall"));
    expect(uninstalled.status).toBe("uninstalled");
  });

  it("snooze hides the item from the inbox and folds it to snoozed", async () => {
    const snoozed = parse(await firstpass("snooze", "mock:issue-1", "1d"));
    expect(snoozed.status, daemon.stderr).toBe("snoozed");
    expect(Date.parse(snoozed.until)).toBeGreaterThan(Date.now());
    expect(localState("mock:issue-1")).toBe("snoozed");
    // a future snooze drops out of the active inbox
    expect(parse(await firstpass("list")).inbox).toHaveLength(0);
  });

  it("mark-handled settles the item and clears it from the inbox", async () => {
    const handled = parse(await firstpass("mark-handled", "mock:issue-1"));
    expect(handled.status, daemon.stderr).toBe("handled");
    expect(localState("mock:issue-1")).toBe("handled");
    expect(parse(await firstpass("list")).inbox).toHaveLength(0);
  });

  it("update reports up_to_date when latest == current", async () => {
    const out = parse(
      await execFileAsync(process.execPath, [CLI, "update"], {
        env: { ...env, FIRSTPASS_LATEST_VERSION: pkg.version },
      }),
    );
    expect(out.status).toBe("up_to_date");
  });
});
