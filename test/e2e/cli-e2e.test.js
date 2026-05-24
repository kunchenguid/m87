import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe("e2e: firstpass CLI with a real daemon (sole consumer)", () => {
  let homeDir;
  let stateDir;
  let env;
  let target;
  let daemon;

  const firstpass = (...args) =>
    execFileAsync(process.execPath, [CLI, ...args], { env });
  const parse = ({ stdout }) => yaml.load(stdout);
  const openDb = () => new Database(join(stateDir, "firstpass.sqlite"));

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "firstpass-e2e-"));
    stateDir = join(homeDir, ".firstpass");
    env = {
      ...process.env,
      HOME: homeDir,
      FIRSTPASS_STATE_DIR: stateDir,
      FIRSTPASS_SKIP_SHELLENV: "1",
      FIRSTPASS_AGENT_PROBE_PATH: "",
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
    await firstpass("init");
    writeConfig();
    await firstpass("plugin", "add", "mock", "--trust");
    // no daemon started yet
    const err = await firstpass("approve", "rec-x").catch((e) => e);
    expect(err.stderr).toContain("daemon not running");
    expect(err.code).toBe(1);
  });

  it("daemon status reports not_running when no daemon is up", async () => {
    await firstpass("init");
    const { stdout } = await firstpass("daemon", "status");
    const status = yaml.load(stdout);
    expect(status.running).toBe(false);
    expect(status.status).toBe("not_running");
  });

  it("daemon syncs+triages; approve flows to handled via the event log", async () => {
    await firstpass("init");
    writeConfig();
    await firstpass("plugin", "add", "mock", "--trust");

    daemon = startFirstpassDaemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));

    // poke a sync; the daemon (sole consumer) ingests + triages
    await firstpass("sync");
    const inbox = await waitFor(async () => {
      const listed = parse(await firstpass("list"));
      return listed.inbox.length === 1 ? listed.inbox : null;
    });
    expect(inbox, daemon.stderr).not.toBeNull();
    const recId = inbox[0].recommendation_id;
    expect(inbox[0].title).toBe("Crash on empty config");

    // gate: external-write needs confirmation
    const needsConfirm = await firstpass("approve", recId).catch((e) => e);
    expect(needsConfirm.stdout).toContain("confirmation_required");

    // confirm -> daemon executes action + fix job -> item settles to handled
    const approved = parse(await firstpass("approve", recId, "--confirm"));
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
    await firstpass("init");
    writeConfig();
    await firstpass("plugin", "add", "mock", "--trust");
    daemon = startFirstpassDaemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    await firstpass("sync");
    const itemId = await waitFor(async () => {
      const db = openDb();
      const row = db.prepare("select id from items").get();
      db.close();
      return row?.id ?? null;
    });
    expect(itemId).toBeTruthy();
    const dismissed = parse(await firstpass("dismiss", itemId));
    expect(dismissed.status).toBe("dismissed");
  });

  it("a restarted daemon resumes from the persisted log and settles in-flight work", async () => {
    await firstpass("init");
    writeConfig();
    await firstpass("plugin", "add", "mock", "--trust");

    // first daemon: sync + triage an item into a live recommendation
    daemon = startFirstpassDaemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    const pid1 = daemon.pid;
    await firstpass("sync");
    const recId = await waitFor(async () => {
      const listed = parse(await firstpass("list"));
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
    daemon = startFirstpassDaemon(env);
    const pid2 = daemon.pid;
    expect(pid2).not.toBe(pid1);
    await waitFor(
      () =>
        existsSync(join(stateDir, "daemon.pid")) &&
        Number(readFileSync(join(stateDir, "daemon.pid"), "utf8")) === pid2,
    );

    // the recommendation survived the restart: approve flows to handled
    await firstpass("approve", recId).catch((e) => e); // confirmation gate
    const approved = parse(await firstpass("approve", recId, "--confirm"));
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
    await firstpass("init");
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
    await firstpass("plugin", "add", "mock", "--trust");

    daemon = startFirstpassDaemon(env);
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    await firstpass("sync");

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
    const status = parse(await firstpass("daemon", "status"));
    expect(status.running).toBe(true);
    const dismissed = parse(await firstpass("dismiss", failed.item_id));
    expect(dismissed.status, daemon.stderr).toBe("dismissed");
  });
});
