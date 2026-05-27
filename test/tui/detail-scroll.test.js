import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { itemId, project } from "../../src/core/projections.js";
import { listInbox } from "../../src/core/views.js";
import { startInteractiveTui } from "../../src/tui/app.js";

// TTY doubles, mirroring select.test.js / info.test.js.
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

async function mountAndType(db, keys) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const { instance, restore } = startInteractiveTui({
    db,
    agentTarget: "acp:claude",
    daemonPid: () => 1234,
    stdout: /** @type {any} */ (stdout),
    stdin: /** @type {any} */ (stdin),
  });
  await sleep(30);
  for (const k of keys) {
    stdin.type(k);
    // escape-prefixed keys (arrows) need a beat for Ink's sequence parser
    await sleep(k.startsWith("\x1b") ? 120 : 30);
  }
  instance.unmount();
  await instance.waitUntilExit();
  restore();
  return stdout.data;
}

/** @param {any} [opts] */
function seedItem(db, ext, title, opts = {}) {
  const { activityAt, options } = opts;
  project(
    db,
    makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      item_id: itemId("mock", ext),
      plugin_id: "mock",
      envelope: {
        title,
        state: "open",
        url: "u",
        fingerprint: `fp-${ext}`,
        activity_at: activityAt,
      },
      attention: { should_surface: true, reason: "r", waiting_on: "user" },
      payload: { type: "issue_opened", external_id: ext, item_type: "issue" },
    }),
  );
  project(
    db,
    makeEvent({
      actor: "agent",
      entity: "recommendation",
      lifecycle: "created",
      item_id: itemId("mock", ext),
      payload: {
        type: "triage_result",
        recommendation_id: `rec-${ext}`,
        summary: "short summary",
        options: options ?? [
          { title: "Do it", confidence: "high", actions: [] },
        ],
      },
    }),
  );
}

function lastApprovalItemId(db) {
  const ev = db
    .prepare(
      "select item_id from events where entity='approval' and lifecycle='created' order by created_at desc, id desc limit 1",
    )
    .get();
  return ev ? ev.item_id : null;
}

describe("tui detail scroll + item nav", () => {
  let dir;
  let db;
  let priorCi;
  beforeEach(() => {
    priorCi = process.env.CI;
    process.env.CI = "true";
    dir = mkdtempSync(join(tmpdir(), "firstpass-scroll-"));
    db = createDatabase(join(dir, "t.sqlite"));
    db.prepare(
      `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at) values ('mock','/b','1','v1','{}','t')`,
    ).run();
  });
  afterEach(() => {
    if (priorCi === undefined) delete process.env.CI;
    else process.env.CI = priorCi;
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("j/k scroll the WILL DO detail to reveal text below the fold", async () => {
    const longBody = `START ${"word ".repeat(300)}TAILTOKEN`;
    seedItem(db, "long", "needs a long reply", {
      options: [
        {
          title: "Reply",
          confidence: "high",
          actions: [
            { id: "a1", action_type: "comment", params: { body: longBody } },
          ],
        },
      ],
    });

    // At rest, the tail of the reply is below the fold.
    const atRest = await mountAndType(db, []);
    expect(atRest).toContain("START");
    expect(atRest).not.toContain("TAILTOKEN");

    // Scrolling down with j brings it into view.
    const scrolled = await mountAndType(
      db,
      Array.from({ length: 40 }, () => "j"),
    );
    expect(scrolled).toContain("TAILTOKEN");
  });

  it("j does not move the inbox selection (arrows still do)", async () => {
    seedItem(db, "a", "first item", { activityAt: "2026-05-21T00:00:00Z" });
    seedItem(db, "b", "second item", { activityAt: "2026-05-20T00:00:00Z" });
    const order = listInbox(db);
    const firstId = order[0].item_id;
    const secondId = order[1].item_id;
    expect(firstId).not.toBe(secondId);

    // j then approve: selection stayed on the first item.
    await mountAndType(db, ["j", "a"]);
    expect(lastApprovalItemId(db)).toBe(firstId);
  });

  it("the down arrow moves the inbox selection", async () => {
    seedItem(db, "a", "first item", { activityAt: "2026-05-21T00:00:00Z" });
    seedItem(db, "b", "second item", { activityAt: "2026-05-20T00:00:00Z" });
    const order = listInbox(db);
    const secondId = order[1].item_id;

    // down then approve: selection moved to the second item.
    await mountAndType(db, ["\x1b[B", "a"]);
    expect(lastApprovalItemId(db)).toBe(secondId);
  });
});
