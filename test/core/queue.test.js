import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent, MAX_DEPTH } from "../../src/core/event.js";
import {
  appendEvent,
  commit,
  deadLetterCount,
  dequeueDue,
  enqueue,
  MAX_ATTEMPTS,
  nextAvailableAt,
  pendingCount,
  recordFailure,
} from "../../src/core/queue.js";

const ev = (over = {}) =>
  makeEvent({
    actor: "plugin:mock",
    entity: "item",
    lifecycle: "created",
    payload: { type: "issue_opened" },
    ...over,
  });

describe("core/queue", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-q-"));
    db = createDatabase(join(dir, "q.sqlite"));
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("enqueue appends to log and queue; dequeue returns it", () => {
    const e = ev();
    const qid = enqueue(db, e);
    expect(qid).toBeTruthy();
    expect(pendingCount(db)).toBe(1);
    const got = dequeueDue(db);
    expect(got.event.id).toBe(e.id);
    expect(got.event.payload.type).toBe("issue_opened");
  });

  it("is idempotent on dedup_key: no double log, no double queue", () => {
    const a = ev({ dedup_key: "fp-1" });
    const b = ev({ dedup_key: "fp-1" });
    expect(enqueue(db, a)).toBeTruthy();
    expect(enqueue(db, b)).toBeNull();
    expect(db.prepare("select count(*) c from events").get().c).toBe(1);
    expect(pendingCount(db)).toBe(1);
  });

  it("appendEvent reports whether the fact was newly appended", () => {
    const e = ev({ dedup_key: "x" });
    expect(appendEvent(db, e)).toBe(true);
    expect(appendEvent(db, ev({ dedup_key: "x" }))).toBe(false);
  });

  it("drops events past the cascade-depth budget", () => {
    const deep = ev({ depth: MAX_DEPTH + 1 });
    expect(enqueue(db, deep)).toBeNull();
    expect(pendingCount(db)).toBe(0);
  });

  it("dequeues by strict lane priority then availability", () => {
    enqueue(db, ev({ payload: { type: "bg" } }), { lane: "background" });
    enqueue(db, ev({ payload: { type: "def" } }), { lane: "default" });
    enqueue(db, ev({ payload: { type: "ui" } }), { lane: "interactive" });
    expect(dequeueDue(db).event.payload.type).toBe("ui");
  });

  it("does not dequeue events scheduled in the future", () => {
    const future = new Date(Date.now() + 60000).toISOString();
    enqueue(db, ev(), { availableAt: future });
    expect(dequeueDue(db)).toBeNull();
    expect(nextAvailableAt(db)).toBe(future);
  });

  it("commit-as-ack: applies projection, enqueues children, deletes row atomically", () => {
    const parent = ev({ item_id: "item-1" });
    enqueue(db, parent);
    const { queueRow } = dequeueDue(db);
    const child = ev({ payload: { type: "child" }, item_id: "item-1" });
    const children = commit(db, queueRow, (txdb) => {
      txdb
        .prepare(
          `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at)
           values ('mock','/bin/mock','1','v1','{}','t')`,
        )
        .run();
      return { children: [{ event: child }] };
    });
    expect(children).toHaveLength(1);
    expect(pendingCount(db)).toBe(1); // parent acked (deleted), child enqueued
    expect(dequeueDue(db).event.payload.type).toBe("child");
    expect(db.prepare("select count(*) c from plugins").get().c).toBe(1);
  });

  it("commit rolls back entirely if work throws (no partial state)", () => {
    const parent = ev();
    enqueue(db, parent);
    const { queueRow } = dequeueDue(db);
    expect(() =>
      commit(db, queueRow, (txdb) => {
        txdb
          .prepare(
            `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at)
             values ('mock','/bin/mock','1','v1','{}','t')`,
          )
          .run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // queue row still present (not acked), no projection write leaked
    expect(pendingCount(db)).toBe(1);
    expect(db.prepare("select count(*) c from plugins").get().c).toBe(0);
  });

  it("recordFailure backs off, then dead-letters at MAX_ATTEMPTS", () => {
    enqueue(db, ev());
    let { queueRow } = dequeueDue(db);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = recordFailure(db, queueRow, new Error("fail"));
      expect(r.status).toBe("pending");
      queueRow = db
        .prepare("select * from queue where id = ?")
        .get(queueRow.id);
    }
    const final = recordFailure(db, queueRow, new Error("fail"));
    expect(final.status).toBe("dead_letter");
    expect(deadLetterCount(db)).toBe(1);
    expect(pendingCount(db)).toBe(0);
  });
});
