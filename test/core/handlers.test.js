import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { runChain } from "../../src/core/handlers.js";
import { itemId, project } from "../../src/core/projections.js";

const ITEM = itemId("mock", "issue-1");

function seedItem(db, localState = "new") {
  db.prepare(
    `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at)
     values ('mock','/bin/mock','1','v1','{}','t')`,
  ).run();
  project(
    db,
    makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      item_id: ITEM,
      plugin_id: "mock",
      envelope: { title: "t", state: "open", url: "u", fingerprint: "fp" },
      attention: { should_surface: true, reason: "r", waiting_on: "user" },
      payload: {
        type: "issue_opened",
        external_id: "issue-1",
        item_type: "issue",
        local_state: localState,
      },
    }),
  );
}

describe("core/handlers", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-h-"));
    db = createDatabase(join(dir, "h.sqlite"));
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("item.created folds the item and requests a triage effect when surfaced", () => {
    db.prepare(
      `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at) values ('mock','/b','1','v1','{}','t')`,
    ).run();
    const e = makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      item_id: ITEM,
      plugin_id: "mock",
      envelope: { title: "t", state: "open", url: "u", fingerprint: "fp" },
      attention: { should_surface: true, reason: "r", waiting_on: "user" },
      payload: {
        type: "issue_opened",
        external_id: "issue-1",
        item_type: "issue",
      },
    });
    const { children, effects } = runChain(db, e);
    expect(
      db.prepare("select local_state from items where id=?").get(ITEM)
        .local_state,
    ).toBe("new");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: "triage", item_id: ITEM });
    expect(children).toHaveLength(0);
  });

  it("does not triage when should_surface is false", () => {
    db.prepare(
      `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at) values ('mock','/b','1','v1','{}','t')`,
    ).run();
    const e = makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      item_id: ITEM,
      plugin_id: "mock",
      envelope: { title: "t", state: "open", url: "u", fingerprint: "fp" },
      attention: { should_surface: false, reason: "fyi", waiting_on: "none" },
      payload: {
        type: "issue_opened",
        external_id: "issue-1",
        item_type: "issue",
      },
    });
    const { effects } = runChain(db, e);
    expect(effects).toHaveLength(0);
  });

  it("snooze schedules a future re-surface event", () => {
    seedItem(db);
    const e = makeEvent({
      actor: "user",
      entity: "item",
      lifecycle: "updated",
      item_id: ITEM,
      payload: {
        type: "snoozed",
        local_state: "snoozed",
        snoozed_until: "2099-01-01T00:00:00Z",
      },
    });
    const { children } = runChain(db, e);
    expect(children).toHaveLength(1);
    expect(children[0].lane).toBe("background");
    expect(children[0].availableAt).toBe("2099-01-01T00:00:00Z");
    expect(children[0].event.payload.type).toBe("snooze_expired");
  });

  it("approval.created fans out into action.created and a fix job", () => {
    seedItem(db);
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
          options: [
            {
              title: "Reply+fix",
              actions: [
                {
                  id: "a1",
                  action_type: "comment",
                  required: true,
                  safety: "external_write",
                },
              ],
              automation: { prompt: "fix it" },
            },
          ],
        },
      }),
    );
    const e = makeEvent({
      actor: "user",
      entity: "approval",
      lifecycle: "created",
      item_id: ITEM,
      payload: {
        type: "approved",
        approval_id: "ap-1",
        recommendation_id: "rec-1",
        option_id: "rec-1-opt-0",
        decision: "approved",
      },
    });
    const { children } = runChain(db, e);
    const names = children.map((c) => `${c.event.entity}.${c.event.lifecycle}`);
    expect(names).toContain("action.created");
    expect(names).toContain("job.created");
    const action = children.find((c) => c.event.entity === "action");
    expect(action.event.payload.action_id).toBe("a1");
  });

  it("gateCheck throws when the approved option does not exist", () => {
    seedItem(db);
    const e = makeEvent({
      actor: "user",
      entity: "approval",
      lifecycle: "created",
      item_id: ITEM,
      payload: {
        type: "approved",
        approval_id: "ap-x",
        recommendation_id: "rec-x",
        option_id: "missing",
        decision: "approved",
      },
    });
    expect(() => runChain(db, e)).toThrow(/unknown option/);
  });

  it("action.created requests an async action effect", () => {
    seedItem(db);
    const e = makeEvent({
      actor: "core",
      entity: "action",
      lifecycle: "created",
      item_id: ITEM,
      plugin_id: "mock",
      payload: {
        type: "queued",
        action_id: "a1",
        approval_id: "ap-1",
        action_type: "comment",
        required: true,
        safety: "external_write",
        request: { action: { id: "a1", action_type: "comment" } },
      },
    });
    const { effects } = runChain(db, e);
    expect(effects[0]).toMatchObject({
      type: "action",
      approval_id: "ap-1",
      action_id: "a1",
    });
  });

  it("action.closed settles the item to handled when all required actions succeed", () => {
    seedItem(db, "approved_pending");
    // one required action, already succeeded
    db.prepare(
      `insert into action_results (id, approval_id, item_id, plugin_id, action_id, action_type, required, depends_on_json, safety, status, request_json) values ('ap-1:a1','ap-1',?, 'mock','a1','comment',1,'[]','external_write','succeeded','{}')`,
    ).run(ITEM);
    const e = makeEvent({
      actor: "plugin:mock",
      entity: "action",
      lifecycle: "closed",
      item_id: ITEM,
      payload: {
        type: "executed",
        action_id: "a1",
        approval_id: "ap-1",
        status: "succeeded",
      },
    });
    const { children } = runChain(db, e);
    expect(children).toHaveLength(1);
    expect(children[0].event.payload.local_state).toBe("handled");
  });

  it("job.created requests an async fix effect", () => {
    seedItem(db);
    const e = makeEvent({
      actor: "core",
      entity: "job",
      lifecycle: "created",
      item_id: ITEM,
      payload: { type: "queued", job_id: "job-1", kind: "fix", prompt: "fix" },
    });
    const { effects } = runChain(db, e);
    expect(effects[0]).toMatchObject({ type: "fix", job_id: "job-1" });
  });
});
