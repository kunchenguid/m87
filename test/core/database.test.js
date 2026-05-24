import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, SCHEMA_VERSION } from "../../src/core/database.js";

describe("core/database", () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-db-"));
    db = createDatabase(join(dir, "firstpass.sqlite"));
  });

  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the immutable log, queue, and projection tables", () => {
    const tables = db
      .prepare(
        "select name from sqlite_master where type='table' order by name",
      )
      .all()
      .map((r) => r.name);
    for (const t of [
      "events",
      "queue",
      "plugins",
      "items",
      "recommendations",
      "recommendation_options",
      "approvals",
      "action_results",
      "jobs",
      "agent_runs",
      "prompt_contexts",
      "retention_policies",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("records the schema version", () => {
    const v = db
      .prepare("select value from schema_meta where key='version'")
      .get();
    expect(v.value).toBe(String(SCHEMA_VERSION));
  });

  it("enforces dedup_key uniqueness but allows many null dedup_keys", () => {
    const insert = db.prepare(
      `insert into events (id, actor, occurred_at, created_at, entity, lifecycle, payload_json, dedup_key)
       values (?, 'core', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'item', 'created', '{}', ?)`,
    );
    insert.run("e1", "k1");
    expect(() => insert.run("e2", "k1")).toThrow();
    // null dedup keys never collide
    insert.run("e3", null);
    insert.run("e4", null);
    const count = db.prepare("select count(*) c from events").get().c;
    expect(count).toBe(3);
  });

  it("lets an event be appended before its item projection exists (no FK deadlock)", () => {
    // The log is primary: item.created is appended before the items row is folded.
    expect(() =>
      db
        .prepare(
          `insert into events (id, actor, occurred_at, created_at, entity, lifecycle, payload_json, item_id)
           values ('e1', 'plugin:mock', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'item', 'created', '{}', 'item-does-not-exist-yet')`,
        )
        .run(),
    ).not.toThrow();
  });

  it("is idempotent across re-open (initialize only once)", () => {
    const path = join(dir, "reopen.sqlite");
    const a = createDatabase(path);
    a.prepare(
      `insert into events (id, actor, occurred_at, created_at, entity, lifecycle, payload_json)
       values ('e1','core','t','t','item','created','{}')`,
    ).run();
    a.close();
    const b = createDatabase(path);
    expect(b.prepare("select count(*) c from events").get().c).toBe(1);
    b.close();
  });
});
