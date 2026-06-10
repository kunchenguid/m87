import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    summary: "Reply to the reporter and open a fix PR",
    evidence: [
      {
        id: "ev-1",
        kind: "event",
        source_ref: "issue-1",
        summary: "Issue opened",
      },
    ],
    options: [
      {
        title: "Reply + automated fix",
        rationale: "Acknowledge and fix the null-config crash",
        confidence: "high",
        waiting_on: "user",
        actions: [
          {
            id: "a1",
            action_type: "comment",
            params: { body: "On it." },
            required: true,
          },
        ],
        automation: {
          kind: "code_fix",
          prompt: "Guard against an empty config object.",
        },
      },
    ],
  },
  usage: { tokens_in: 120, tokens_out: 60 },
};

describe("e2e: m87 CLI with a real daemon (sole consumer)", () => {
  let homeDir;
  let stateDir;
  let env;
  let target;
  let daemon;

  const m87 = (...args) => runM87(CLI, args, env);
  const parse = ({ stdout }) => yaml.load(stdout);
  const openDb = () => new Database(join(stateDir, "m87.sqlite"));

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "m87-e2e-"));
    stateDir = join(homeDir, ".m87");
    env = {
      ...process.env,
      HOME: homeDir,
      M87_STATE_DIR: stateDir,
      M87_SKIP_SHELLENV: "1",
      M87_AGENT_PROBE_PATH: "",
    };
    target = await createMockAcpTarget(
      { homeDir, stateDir },
      { response: RECOMMENDATION },
    );
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeConfig(extra = {}) {
    writeFileSync(
      join(stateDir, "config.yaml"),
      yaml.dump({
        agent: "acp:claude",
        poll_interval: 1,
        acp_registry_overrides: { claude: target.executablePath },
        plugins: {},
        ...extra,
      }),
    );
  }

  it("mutating commands require a running daemon", async () => {
    await m87("init");
    writeConfig();
    await m87("plugin", "add", "mock");
    // no daemon started yet
    const err = await m87("approve", "rec-x").catch((e) => e);
    expect(err.stderr).toContain("daemon not running");
    expect(err.code).toBe(1);
  });

  it("plugin add installs immediately with no trust gate", async () => {
    await m87("init");
    const added = parse(await m87("plugin", "add", "mock"));
    expect(added.status).toBe("installed");
    expect(added.plugin.id).toBe("mock");

    const listed = parse(await m87("plugin", "list"));
    expect(listed.installed.map((p) => p.id)).toContain("mock");
  });

  it("daemon status reports not_running when no daemon is up", async () => {
    await m87("init");
    const { stdout } = await m87("daemon", "status");
    const status = yaml.load(stdout);
    expect(status.running).toBe(false);
    expect(status.status).toBe("not_running");
  });

  it("daemon uninstall exits nonzero when service deactivation fails", async () => {
    await m87("init");
    await runM87(CLI, ["daemon", "install"], {
      ...env,
      M87_SERVICE_DRY_RUN: "1",
    });

    const binDir = join(homeDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const serviceCommand =
      process.platform === "darwin"
        ? "launchctl"
        : process.platform === "win32"
          ? "schtasks"
          : "systemctl";
    const fakeCommand = join(binDir, serviceCommand);
    writeFileSync(fakeCommand, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeCommand, 0o755);

    const err = await runM87(CLI, ["daemon", "uninstall"], {
      ...env,
      M87_SERVICE_DRY_RUN: "0",
      PATH: `${binDir}${delimiter}${env.PATH}`,
    }).catch((e) => e);
    const result = yaml.load(err.stdout);
    expect(err.code).toBe(1);
    expect(result.status).toBe("uninstalled");
    expect(result.deactivation).toBe("deactivate_failed");
  });

  it("daemon syncs+triages; approve flows to handled via the event log", async () => {
    await m87("init");
    writeConfig();
    await m87("plugin", "add", "mock");

    daemon = startM87Daemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));

    // poke a sync; the daemon (sole consumer) ingests + triages
    await m87("sync");
    const inbox = await waitFor(async () => {
      const listed = parse(await m87("list"));
      return listed.inbox.length === 1 ? listed.inbox : null;
    });
    expect(inbox, daemon.stderr).not.toBeNull();
    const recId = inbox[0].recommendation_id;
    expect(inbox[0].title).toBe("Crash on empty config");

    // gate: external-write needs confirmation
    const needsConfirm = await m87("approve", recId).catch((e) => e);
    expect(needsConfirm.stdout).toContain("confirmation_required");

    // confirm -> daemon executes action + fix job -> item settles to handled
    const approved = parse(await m87("approve", recId, "--confirm"));
    expect(approved.item_state, daemon.stderr).toBe("handled");

    const db = openDb();
    try {
      expect(
        db.prepare("select local_state from items").get().local_state,
      ).toBe("handled");
      expect(db.prepare("select status from action_results").get().status).toBe(
        "succeeded",
      );
      const job = db.prepare("select * from jobs").get();
      expect(job.status).toBe("succeeded");
      expect(JSON.parse(job.metadata_json).pr_url).toContain("mock://pull/");

      // triage persisted the prompt context under the retention policy
      const ctx = db.prepare("select * from prompt_contexts").get();
      expect(ctx.retention_class).toBe("prompt");
      expect(ctx.recommendation_id).toBe(recId);
      expect(ctx.expires_at).not.toBeNull();
      expect(ctx.agent_context_json).not.toBe("null");

      const root = db
        .prepare(
          "select id from events where entity='item' and lifecycle='created'",
        )
        .get().id;
      const lifecycles = db
        .prepare(
          "select distinct entity||'.'||lifecycle n from events order by n",
        )
        .all()
        .map((r) => r.n);
      expect(lifecycles).toEqual(
        expect.arrayContaining([
          "item.created",
          "recommendation.created",
          "approval.created",
          "action.created",
          "action.closed",
          "job.created",
          "job.closed",
          "item.updated",
        ]),
      );
      expect(
        db
          .prepare(
            "select root_event_id from events where entity='recommendation'",
          )
          .get().root_event_id,
      ).toBe(root);
      expect(
        db
          .prepare("select count(*) c from queue where status='dead_letter'")
          .get().c,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("dismiss flows through the daemon", async () => {
    await m87("init");
    writeConfig();
    await m87("plugin", "add", "mock");
    daemon = startM87Daemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    await m87("sync");
    const itemId = await waitFor(async () => {
      const db = openDb();
      const row = db.prepare("select id from items").get();
      db.close();
      return row?.id ?? null;
    });
    expect(itemId).toBeTruthy();
    const dismissed = parse(await m87("dismiss", itemId));
    expect(dismissed.status).toBe("dismissed");
  });

  it("a restarted daemon resumes from the persisted log and settles in-flight work", async () => {
    await m87("init");
    writeConfig();
    await m87("plugin", "add", "mock");

    // first daemon: sync + triage an item into a live recommendation
    daemon = startM87Daemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    const pid1 = daemon.pid;
    await m87("sync");
    const recId = await waitFor(async () => {
      const listed = parse(await m87("list"));
      return listed.inbox.length === 1
        ? listed.inbox[0].recommendation_id
        : null;
    });
    expect(recId, daemon.stderr).toBeTruthy();
    const eventsBeforeRestart = openDb();
    const countBefore = eventsBeforeRestart
      .prepare("select count(*) c from events")
      .get().c;
    eventsBeforeRestart.close();

    // crash + restart: a fresh process picks up the same state dir
    await daemon.stop();
    daemon = startM87Daemon(env);
    const pid2 = daemon.pid;
    expect(pid2).not.toBe(pid1);
    await waitFor(
      () =>
        existsSync(join(stateDir, "daemon.pid")) &&
        Number(readFileSync(join(stateDir, "daemon.pid"), "utf8")) === pid2,
    );

    // the recommendation survived the restart: approve flows to handled
    await m87("approve", recId).catch((e) => e); // confirmation gate
    const approved = parse(await m87("approve", recId, "--confirm"));
    expect(approved.item_state, daemon.stderr).toBe("handled");

    const db = openDb();
    try {
      expect(
        db.prepare("select local_state from items").get().local_state,
      ).toBe("handled");
      expect(
        db
          .prepare("select count(*) c from queue where status='dead_letter'")
          .get().c,
      ).toBe(0);
      // the post-restart daemon kept appending to the same log
      expect(
        db.prepare("select count(*) c from events").get().c,
      ).toBeGreaterThan(countBefore);
    } finally {
      db.close();
    }
  });

  it("a failing agent is recorded without wedging the daemon", async () => {
    await m87("init");
    // point the agent at a target that returns no recommendation -> triage throws
    const badTarget = await createMockAcpTarget(
      { homeDir, stateDir },
      { response: { status: "ok" } },
    );
    writeFileSync(
      join(stateDir, "config.yaml"),
      yaml.dump({
        agent: "acp:claude",
        poll_interval: 1,
        acp_registry_overrides: { claude: badTarget.executablePath },
        plugins: {},
      }),
    );
    await m87("plugin", "add", "mock");

    daemon = startM87Daemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    await m87("sync");

    // the failure surfaces as a failed agent_run, not a crashed daemon
    const failed = await waitFor(() => {
      const db = openDb();
      const row = db
        .prepare("select item_id, error from agent_runs where status='failed'")
        .get();
      db.close();
      return row ?? null;
    });
    expect(failed, daemon.stderr).not.toBeNull();
    expect(failed.error).toContain("no usable recommendation");

    const db = openDb();
    try {
      // the item never reached 'recommended'; effect failures don't dead-letter
      const item = db.prepare("select local_state from items").get();
      expect(item.local_state).toBe("new");
      expect(
        db
          .prepare("select count(*) c from queue where status='dead_letter'")
          .get().c,
      ).toBe(0);
    } finally {
      db.close();
    }

    // the daemon survived: it still reports running and still consumes events
    const status = parse(await m87("daemon", "status"));
    expect(status.running).toBe(true);
    const dismissed = parse(await m87("dismiss", failed.item_id));
    expect(dismissed.status, daemon.stderr).toBe("dismissed");
  });
});
