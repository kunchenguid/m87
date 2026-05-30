import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { itemId, project } from "../../src/core/projections.js";
import { appendEvent } from "../../src/core/queue.js";
import { startInteractiveTui } from "../../src/tui/app.js";

const ITEM = itemId("mock", "issue-1");
const ITEM_2 = itemId("mock", "issue-2");

// Minimal TTY doubles, mirroring info.test.js. Ink batches frames and flushes on
// unmount when CI is set, so we drive keypresses then inspect the db afterwards.
class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  data = "";
  write(chunk) {
    this.data += chunk;
    return true;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  queue = [];
  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  ref() {}
  unref() {}
  resume() {}
  pause() {}
  read() {
    return this.queue.shift() ?? null;
  }
  type(str) {
    this.queue.push(str);
    this.emit("readable");
  }
}

// Seed one surfaced item with a three-option recommendation. Option ids default
// to `${recId}-opt-${position}` in the projection, so positions are addressable.
function seedItem(
  db,
  {
    item = ITEM,
    externalId = "issue-1",
    recId = "rec-1",
    activityAt = "2024-01-02T00:00:00.000Z",
  } = {},
) {
  db.prepare(
    `insert or ignore into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at) values ('mock','/b','1','v1','{}','t')`,
  ).run();
  project(
    db,
    makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      item_id: item,
      plugin_id: "mock",
      envelope: {
        title: "release 1.21.5",
        state: "open",
        url: "u",
        activity_at: activityAt,
        fingerprint: "fp",
      },
      attention: {
        should_surface: true,
        reason: "assigned",
        waiting_on: "user",
      },
      payload: {
        type: "pr_opened",
        external_id: externalId,
        item_type: "pull_request",
      },
    }),
  );
  project(
    db,
    makeEvent({
      actor: "agent",
      entity: "recommendation",
      lifecycle: "created",
      item_id: item,
      payload: {
        type: "triage_result",
        recommendation_id: recId,
        summary: "Cut the release",
        options: [
          {
            title: "Merge",
            confidence: "high",
            actions: [{ id: "a1", action_type: "merge" }],
          },
          { title: "Hold", confidence: "medium", actions: [] },
          { title: "Comment", confidence: "low", actions: [] },
        ],
      },
    }),
  );
}

function seed(db) {
  seedItem(db);
}

async function mountAndType(db, keys) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const { instance, restore } = startInteractiveTui({
    db,
    agentTarget: "acp:claude",
    daemonPid: () => 1234, // online, so decisions are enqueued
    stdout: /** @type {any} */ (stdout),
    stdin: /** @type {any} */ (stdin),
  });
  await sleep(30);
  for (const k of keys) {
    if (typeof k === "function") {
      k();
      await sleep(40);
      continue;
    }
    stdin.type(k);
    await sleep(k === "\x1b" ? 120 : 40);
  }
  instance.unmount();
  await instance.waitUntilExit();
  restore();
  return stdout.data;
}

function dismissItem(db, item) {
  const event = makeEvent({
    actor: "user",
    entity: "item",
    lifecycle: "updated",
    item_id: item,
    payload: { type: "dismissed", local_state: "dismissed" },
  });
  appendEvent(db, event);
  project(db, event);
}

function lastApprovalOptionId(db) {
  const ev = db
    .prepare(
      "select payload_json from events where entity='approval' and lifecycle='created' order by created_at desc, id desc limit 1",
    )
    .get();
  return ev ? JSON.parse(ev.payload_json).option_id : null;
}

function approvalCount(db) {
  return db
    .prepare("select count(*) c from events where entity='approval'")
    .get().c;
}

describe("tui option select-then-approve", () => {
  let dir;
  let db;
  let priorCi;
  beforeEach(() => {
    priorCi = process.env.CI;
    process.env.CI = "true";
    dir = mkdtempSync(join(tmpdir(), "m87-select-"));
    db = createDatabase(join(dir, "t.sqlite"));
    seed(db);
  });
  afterEach(() => {
    if (priorCi === undefined) delete process.env.CI;
    else process.env.CI = priorCi;
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("approves the recommended (first) option by default", async () => {
    await mountAndType(db, ["a"]);
    expect(lastApprovalOptionId(db)).toBe("rec-1-opt-0");
  });

  it("a number key selects an option without approving it", async () => {
    await mountAndType(db, ["3"]);
    expect(approvalCount(db)).toBe(0);
  });

  it("selecting option 2 then pressing a approves that option", async () => {
    await mountAndType(db, ["2", "a"]);
    expect(lastApprovalOptionId(db)).toBe("rec-1-opt-1");
  });

  it("clamps an out-of-range number to the last option", async () => {
    await mountAndType(db, ["9", "a"]);
    expect(lastApprovalOptionId(db)).toBe("rec-1-opt-2");
  });

  it("resets the selected option when the current recommendation changes", async () => {
    seedItem(db, {
      item: ITEM_2,
      externalId: "issue-2",
      recId: "rec-2",
      activityAt: "2024-01-01T00:00:00.000Z",
    });
    await mountAndType(db, ["2", () => dismissItem(db, ITEM), "r", "a"]);
    expect(lastApprovalOptionId(db)).toBe("rec-2-opt-0");
  });
});
