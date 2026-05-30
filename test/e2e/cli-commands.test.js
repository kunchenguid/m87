import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import pkg from "../../package.json" with { type: "json" };

import {
  createMockAcpTarget,
  runM87,
  startM87Daemon,
  waitFor,
} from "../support/e2e-harness.js";

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

  const m87 = (...args) => runM87(CLI, args, env);
  const parse = ({ stdout }) => yaml.load(stdout);
  const localState = (itemId) => {
    const db = new Database(join(stateDir, "m87.sqlite"));
    const row = db
      .prepare("select local_state from items where id=?")
      .get(itemId);
    db.close();
    return row?.local_state;
  };

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "m87-cmds-"));
    stateDir = join(homeDir, ".m87");
    env = {
      ...process.env,
      HOME: homeDir,
      M87_STATE_DIR: stateDir,
      M87_SKIP_SHELLENV: "1",
      M87_AGENT_PROBE_PATH: "",
      M87_SERVICE_DRY_RUN: "1",
    };
    target = await createMockAcpTarget(
      { homeDir, stateDir },
      { response: RECOMMENDATION },
    );
    await m87("init");
    writeFileSync(
      join(stateDir, "config.yaml"),
      yaml.dump({
        agent: "acp:claude",
        poll_interval: 1,
        acp_registry_overrides: { claude: target.executablePath },
        plugins: {},
      }),
    );
    await m87("plugin", "add", "mock");
    daemon = startM87Daemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    await m87("sync");
    await waitFor(async () => {
      const listed = parse(await m87("list"));
      return listed.inbox.length === 1;
    });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("view shows the item and its recommendation", async () => {
    const v = parse(await m87("view", "mock:issue-1"));
    expect(v.status).toBe("found");
    expect(v.item.title).toBe("Crash on empty config");
    expect(v.recommendation.summary).toBe("Reply and fix");
  });

  it("open prints the source url; copy-handoff prints a prompt", async () => {
    expect(parse(await m87("open", "mock:issue-1")).url).toBe("mock://issue/1");
    expect(
      parse(await m87("copy-handoff", "mock:issue-1")).handoff_prompt,
    ).toContain("Crash on empty config");
  });

  it("rerun supersedes and re-triages with a fresh recommendation", async () => {
    const before = parse(await m87("view", "mock:issue-1")).recommendation.id;
    const r = parse(
      await m87("rerun", "mock:issue-1", "--instructions", "be terse"),
    );
    expect(r.status, daemon.stderr).toBe("reran");
    const after = parse(await m87("view", "mock:issue-1")).recommendation.id;
    expect(after).not.toBe(before);
  });

  it("mutating commands refuse when the daemon is down", async () => {
    await daemon.stop();
    daemon = undefined;
    const err = await m87("dismiss", "mock:issue-1").catch((e) => e);
    expect(err.stderr).toContain("daemon not running");
  });

  it("state export -> import round-trips the plugin set", async () => {
    const file = join(homeDir, "state.yaml");
    const { stdout } = await m87("state", "export");
    writeFileSync(file, stdout);
    const imported = parse(await m87("state", "import", file));
    expect(imported.status).toBe("imported");
    expect(imported.plugins).toBe(1);
  });

  it("daemon status reports the running daemon", async () => {
    const status = parse(await m87("daemon", "status"));
    expect(status.running).toBe(true);
    expect(typeof status.pid).toBe("number");
  });

  it("daemon install/uninstall manage a service unit (dry run)", async () => {
    const installed = parse(await m87("daemon", "install"));
    expect(installed.status).toBe("installed");
    expect(["launchd", "systemd", "schtasks"]).toContain(installed.manager);
    expect(installed.activation).toBe("skipped_dry_run");
    const uninstalled = parse(await m87("daemon", "uninstall"));
    expect(uninstalled.status).toBe("uninstalled");
  });

  it("snooze hides the item from the inbox and folds it to snoozed", async () => {
    const snoozed = parse(await m87("snooze", "mock:issue-1", "1d"));
    expect(snoozed.status, daemon.stderr).toBe("snoozed");
    expect(Date.parse(snoozed.until)).toBeGreaterThan(Date.now());
    expect(localState("mock:issue-1")).toBe("snoozed");
    // a future snooze drops out of the active inbox
    expect(parse(await m87("list")).inbox).toHaveLength(0);
  });

  it("mark-handled settles the item and clears it from the inbox", async () => {
    const handled = parse(await m87("mark-handled", "mock:issue-1"));
    expect(handled.status, daemon.stderr).toBe("handled");
    expect(localState("mock:issue-1")).toBe("handled");
    expect(parse(await m87("list")).inbox).toHaveLength(0);
  });

  it("update reports up_to_date when latest == current", async () => {
    const out = parse(
      await runM87(CLI, ["update"], {
        ...env,
        M87_LATEST_VERSION: pkg.version,
      }),
    );
    expect(out.status).toBe("up_to_date");
  });
});
