import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { project, itemId } from "../../src/core/projections.js";
import { buildInboxModel } from "../../src/tui/render.js";

const ITEM = itemId("mock", "issue-1");

function surfaceItem(db, envelope = {}, attention = {}, payload = {}) {
  project(
    db,
    makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      item_id: ITEM,
      plugin_id: "mock",
      envelope: {
        title: "Crash on empty config",
        state: "open",
        url: "u",
        fingerprint: "fp",
        ...envelope,
      },
      attention: {
        should_surface: true,
        reason: "assigned",
        waiting_on: "user",
        ...attention,
      },
      payload: {
        type: "issue_opened",
        external_id: "issue-1",
        item_type: "issue",
        ...payload,
      },
    }),
  );
}

function recommend(db, options) {
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
        summary: "Reply and fix",
        options,
      },
    }),
  );
}

describe("tui/buildInboxModel", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-model-"));
    db = createDatabase(join(dir, "t.sqlite"));
    db.prepare(
      `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at) values ('mock','/b','1','v1','{}','t')`,
    ).run();
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports an empty inbox with zeroed status and the agent target", () => {
    const model = buildInboxModel(db, {
      agentTarget: "acp:claude",
      daemonRunning: false,
    });
    expect(model.count).toBe(0);
    expect(model.items).toEqual([]);
    expect(model.detail).toBeNull();
    expect(model.status.agentTarget).toBe("acp:claude");
    expect(model.status.events).toBe(0);
    expect(model.daemonRunning).toBe(false);
  });

  it("projects a surfaced item with selection, confidence, and option counts", () => {
    surfaceItem(db);
    recommend(db, [
      {
        title: "Reply",
        confidence: "high",
        actions: [{ id: "a1", action_type: "comment" }],
        automation: { prompt: "x" },
      },
      { title: "Close", confidence: "low", actions: [] },
    ]);
    const model = buildInboxModel(db, {
      selectedIndex: 0,
      agentTarget: "none",
      daemonRunning: true,
    });
    expect(model.count).toBe(1);
    const row = model.items[0];
    expect(row.itemId).toBe("mock:issue-1");
    expect(row.title).toBe("Crash on empty config");
    expect(row.selected).toBe(true);
    expect(row.confidence).toBe("high");
    expect(row.optionCount).toBe(2);
    expect(row.hasAutomation).toBe(true);
    expect(model.detail.summary).toBe("Reply and fix");
    expect(model.detail.options).toHaveLength(2);
    expect(model.detail.options[0]).toMatchObject({
      title: "Reply",
      confidence: "high",
      actionCount: 1,
      hasAutomation: true,
    });
  });

  it("flags urgent items and carries plugin badges", () => {
    surfaceItem(
      db,
      {},
      { priority_hint: "urgent" },
      { metadata: { role: "contributor", stale: true } },
    );
    recommend(db, [{ title: "Wait", confidence: "medium", actions: [] }]);
    const model = buildInboxModel(db, { selectedIndex: 0 });
    const row = model.items[0];
    expect(row.urgent).toBe(true);
    expect(row.badges).toContain("contrib");
    expect(row.badges).toContain("stale");
  });

  it("renders the plugin's display_handle and age, and omits the default 'waiting on you'", () => {
    surfaceItem(
      db,
      { activity_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() },
      { waiting_on: "user" },
      {
        item_type: "pull_request",
        metadata: { display_handle: "kunchenguid/firstpass · PR #221" },
      },
    );
    recommend(db, [{ title: "Merge", confidence: "high", actions: [] }]);
    const meta = buildInboxModel(db, { selectedIndex: 0 }).items[0].meta;
    expect(meta.handle).toBe("kunchenguid/firstpass · PR #221");
    expect(meta.age).toBe("2h");
    expect(meta.text).toContain("kunchenguid/firstpass · PR #221");
    expect(meta.text).toContain("2h");
    // the inbox is your queue by default, so "waiting on you" is not repeated per row
    expect(meta.waiting).toBeNull();
    expect(meta.text).not.toContain("waiting on you");
  });

  it("surfaces only the non-default waiting states (e.g. waiting on others)", () => {
    surfaceItem(db, {}, { waiting_on: "other" });
    recommend(db, [{ title: "Wait", confidence: "high", actions: [] }]);
    const meta = buildInboxModel(db, { selectedIndex: 0 }).items[0].meta;
    expect(meta.waiting).toBe("waiting on others");
    expect(meta.text).toContain("waiting on others");
  });

  it("falls back to the humanized item type when no display_handle is set", () => {
    // No source-specific handle: any plugin's items still get a generic label
    // from item_type (a core field) rather than a blank meta line.
    surfaceItem(db, {}, {}, { item_type: "email_thread" });
    recommend(db, [{ title: "Reply", confidence: "high", actions: [] }]);
    const meta = buildInboxModel(db, { selectedIndex: 0 }).items[0].meta;
    expect(meta.handle).toBe("email thread");
  });

  it("numbers recommendation options and marks the selected one", () => {
    surfaceItem(db);
    recommend(db, [
      { title: "Merge", confidence: "high", actions: [] },
      { title: "Hold", confidence: "medium", actions: [] },
      { title: "Comment", confidence: "low", actions: [] },
    ]);
    const model = buildInboxModel(db, { selectedIndex: 0, selectedOption: 1 });
    expect(model.detail.options[0].number).toBe(1);
    expect(model.detail.options[1].number).toBe(2);
    expect(model.detail.options[2].number).toBe(3);
    expect(model.detail.options[0].selected).toBe(false);
    expect(model.detail.options[1].selected).toBe(true);
  });

  it("threads each option's actions and automation for the WILL DO detail view", () => {
    surfaceItem(db);
    recommend(db, [
      {
        title: "Reply",
        confidence: "high",
        actions: [
          {
            id: "a1",
            action_type: "comment",
            params: { body: "Thanks for the update" },
          },
        ],
        automation: { kind: "code_fix", prompt: "narrow the scope" },
      },
    ]);
    const opt = buildInboxModel(db, { selectedIndex: 0 }).detail.options[0];
    expect(opt.actions).toEqual([
      { type: "comment", preview: "Thanks for the update" },
    ]);
    expect(opt.automation).toMatchObject({ prompt: "narrow the scope" });
  });

  it("defaults the selected option to the first (recommended) one", () => {
    surfaceItem(db);
    recommend(db, [
      { title: "Merge", confidence: "high", actions: [] },
      { title: "Hold", confidence: "low", actions: [] },
    ]);
    const model = buildInboxModel(db, { selectedIndex: 0 });
    expect(model.detail.options[0].selected).toBe(true);
    expect(model.detail.options[1].selected).toBe(false);
  });
});
