import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { itemId, project } from "../../src/core/projections.js";
import { listInbox } from "../../src/core/views.js";

const ITEM = itemId("mock", "issue-1");

function seedSurfacedItem(db) {
  db.prepare(
    `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at) values ('mock','/b','1','v1','{}','t')`,
  ).run();
  project(
    db,
    makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      item_id: ITEM,
      plugin_id: "mock",
      envelope: { title: "Fix bug", state: "open", url: "u", fingerprint: "f" },
      attention: { should_surface: true, reason: "assigned" },
      payload: {
        type: "issue_opened",
        external_id: "issue-1",
        item_type: "issue",
      },
    }),
  );
  project(
    db,
    makeEvent({
      actor: "agent",
      entity: "recommendation",
      lifecycle: "created",
      item_id: ITEM,
      payload: {
        type: "triage_result",
        recommendation_id: "rec-1",
        summary: "s",
        options: [{ title: "o" }],
      },
    }),
  );
}

describe("core/views listInbox", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m87-views-"));
    db = createDatabase(join(dir, "v.sqlite"));
    seedSurfacedItem(db);
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists a surfaced item with its live recommendation", () => {
    const rows = listInbox(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      item_id: ITEM,
      recommendation_id: "rec-1",
    });
  });

  it("lists an item once even when historical state holds two live recs", () => {
    // Databases folded before the one-live-rec-per-item rule can hold several
    // live recommendations for one item; the view must still dedup to the
    // newest one instead of rendering the item once per rec.
    db.prepare(
      `insert into recommendations
        (id, item_id, agent_run_id, source_event_id, summary, evidence_json,
         activity_at, content_fingerprint, created_at, superseded_at)
       values ('rec-2', ?, null, 'ev-2', 's2', '[]', 't2', '', '2099-01-01T00:00:00Z', null)`,
    ).run(ITEM);
    const rows = listInbox(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].recommendation_id).toBe("rec-2");
  });
});
