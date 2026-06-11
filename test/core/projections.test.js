import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { itemId, project, replayFold } from "../../src/core/projections.js";

const ITEM = itemId("mock", "issue-1");

function seedPlugin(db) {
  db.prepare(
    `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at)
     values ('mock','/bin/mock','1','v1','{}','t')`,
  ).run();
}

const itemCreated = (over = {}) =>
  makeEvent({
    actor: "plugin:mock",
    entity: "item",
    lifecycle: "created",
    item_id: ITEM,
    plugin_id: "mock",
    envelope: { title: "Fix bug", state: "open", url: "u", fingerprint: "fp1" },
    attention: { should_surface: true, reason: "assigned", waiting_on: "user" },
    payload: {
      type: "issue_opened",
      external_id: "issue-1",
      item_type: "issue",
    },
    ...over,
  });

describe("core/projections", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m87-proj-"));
    db = createDatabase(join(dir, "p.sqlite"));
    seedPlugin(db);
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("folds item.created into an items row in local_state 'new'", () => {
    project(db, itemCreated());
    const item = db.prepare("select * from items where id=?").get(ITEM);
    expect(item.title).toBe("Fix bug");
    expect(item.local_state).toBe("new");
    expect(item.attention_reason).toBe("assigned");
  });

  it("is idempotent: folding item.created twice yields one row, same state", () => {
    const e = itemCreated();
    project(db, e);
    project(db, e);
    expect(db.prepare("select count(*) c from items").get().c).toBe(1);
  });

  it("item.updated only changes provided fields and applies local_state", () => {
    project(db, itemCreated());
    project(
      db,
      makeEvent({
        actor: "user",
        entity: "item",
        lifecycle: "updated",
        item_id: ITEM,
        payload: {
          type: "snoozed",
          local_state: "snoozed",
          snoozed_until: "2099-01-01T00:00:00Z",
        },
      }),
    );
    const item = db.prepare("select * from items where id=?").get(ITEM);
    expect(item.local_state).toBe("snoozed");
    expect(item.snoozed_until).toBe("2099-01-01T00:00:00Z");
    expect(item.title).toBe("Fix bug"); // preserved
  });

  it("recommendation.created materializes rec + options and surfaces the item", () => {
    project(db, itemCreated());
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
          options: [
            { title: "Reply", actions: [{ id: "a1", action_type: "comment" }] },
          ],
        },
      }),
    );
    expect(db.prepare("select count(*) c from recommendations").get().c).toBe(
      1,
    );
    expect(
      db.prepare("select count(*) c from recommendation_options").get().c,
    ).toBe(1);
    expect(
      db.prepare("select local_state from items where id=?").get(ITEM)
        .local_state,
    ).toBe("recommended");
  });

  it("a newer recommendation supersedes the previous live one for the same item", () => {
    project(db, itemCreated());
    const rec = (id) =>
      makeEvent({
        actor: "agent",
        entity: "recommendation",
        lifecycle: "created",
        item_id: ITEM,
        payload: {
          type: "triage_result",
          recommendation_id: id,
          summary: "s",
          options: [{ title: "o" }],
        },
      });
    const first = rec("rec-1");
    project(db, first);
    project(db, rec("rec-2"));
    const liveIds = () =>
      db
        .prepare("select id from recommendations where superseded_at is null")
        .all()
        .map((r) => r.id);
    expect(liveIds()).toEqual(["rec-2"]);
    // Refolding the older event (replay) must not supersede the newer rec.
    project(db, first);
    expect(liveIds()).toEqual(["rec-2"]);
  });

  it("a stale recommendation cannot supersede the current live recommendation", () => {
    project(db, itemCreated());
    project(
      db,
      makeEvent({
        actor: "plugin:mock",
        entity: "item",
        lifecycle: "updated",
        item_id: ITEM,
        envelope: {
          activity_at: "2024-01-02T00:00:00.000Z",
          fingerprint: "fp2",
        },
        payload: { type: "issue_updated", local_state: "new" },
      }),
    );

    const rec = (id, activityAt, fingerprint) =>
      makeEvent({
        actor: "agent",
        entity: "recommendation",
        lifecycle: "created",
        item_id: ITEM,
        payload: {
          type: "triage_result",
          recommendation_id: id,
          activity_at: activityAt,
          content_fingerprint: fingerprint,
          summary: "s",
          options: [{ title: "o" }],
        },
      });

    project(db, rec("rec-2", "2024-01-02T00:00:00.000Z", "fp2"));
    project(db, rec("rec-1", "2024-01-01T00:00:00.000Z", "fp1"));

    const recommendations = db
      .prepare("select id, superseded_at from recommendations order by id")
      .all();
    expect(recommendations).toMatchObject([
      { id: "rec-1", superseded_at: expect.any(String) },
      { id: "rec-2", superseded_at: null },
    ]);
    expect(
      db.prepare("select local_state from items where id=?").get(ITEM)
        .local_state,
    ).toBe("recommended");
  });

  it("approval.created writes a write-once approval and supersedes the rec", () => {
    project(db, itemCreated());
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
    const approval = makeEvent({
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
    project(db, approval);
    project(db, approval); // idempotent (write-once)
    expect(db.prepare("select count(*) c from approvals").get().c).toBe(1);
    expect(
      db.prepare("select local_state from items where id=?").get(ITEM)
        .local_state,
    ).toBe("approved_pending");
    expect(
      db
        .prepare("select superseded_at from recommendations where id='rec-1'")
        .get().superseded_at,
    ).not.toBeNull();
  });

  it("action.created then action.closed records and resolves the result", () => {
    project(db, itemCreated());
    project(
      db,
      makeEvent({
        actor: "core",
        entity: "action",
        lifecycle: "created",
        item_id: ITEM,
        payload: {
          type: "queued",
          action_id: "a1",
          approval_id: "ap-1",
          action_type: "comment",
          required: true,
          safety: "external_write",
          request: { x: 1 },
        },
      }),
    );
    expect(
      db.prepare("select status from action_results where id='ap-1:a1'").get()
        .status,
    ).toBe("running");
    project(
      db,
      makeEvent({
        actor: "plugin:mock",
        entity: "action",
        lifecycle: "closed",
        item_id: ITEM,
        payload: {
          type: "executed",
          action_id: "a1",
          approval_id: "ap-1",
          status: "succeeded",
          result: { ok: true },
        },
      }),
    );
    const r = db
      .prepare("select * from action_results where id='ap-1:a1'")
      .get();
    expect(r.status).toBe("succeeded");
    expect(JSON.parse(r.result_json).ok).toBe(true);
  });

  it("job lifecycle: created -> updated(phase) -> closed(pr_opened)", () => {
    project(db, itemCreated());
    project(
      db,
      makeEvent({
        actor: "core",
        entity: "job",
        lifecycle: "created",
        item_id: ITEM,
        payload: {
          type: "queued",
          job_id: "job-1",
          kind: "fix",
          prompt: "fix it",
        },
      }),
    );
    expect(
      db.prepare("select status,phase from jobs where id='job-1'").get(),
    ).toMatchObject({ status: "queued", phase: "pending" });
    project(
      db,
      makeEvent({
        actor: "core",
        entity: "job",
        lifecycle: "updated",
        item_id: ITEM,
        payload: {
          type: "running",
          job_id: "job-1",
          status: "running",
          phase: "running_agent",
        },
      }),
    );
    expect(
      db.prepare("select status,phase from jobs where id='job-1'").get(),
    ).toMatchObject({ status: "running", phase: "running_agent" });
    project(
      db,
      makeEvent({
        actor: "core",
        entity: "job",
        lifecycle: "closed",
        item_id: ITEM,
        payload: {
          type: "pr_opened",
          job_id: "job-1",
          status: "succeeded",
          phase: "pr_opened",
          metadata: { pr_url: "http://pr/1" },
        },
      }),
    );
    const job = db.prepare("select * from jobs where id='job-1'").get();
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.metadata_json).pr_url).toBe("http://pr/1");
    expect(job.completed_at).not.toBeNull();
  });

  it("job.updated projects the PR-probe schedule; job.closed clears it", () => {
    project(db, itemCreated());
    project(
      db,
      makeEvent({
        actor: "core",
        entity: "job",
        lifecycle: "created",
        item_id: ITEM,
        payload: { type: "queued", job_id: "job-2", kind: "fix", prompt: "x" },
      }),
    );
    project(
      db,
      makeEvent({
        actor: "core",
        entity: "job",
        lifecycle: "updated",
        item_id: ITEM,
        payload: {
          type: "waiting_for_pr",
          job_id: "job-2",
          status: "running",
          phase: "waiting_for_pr",
          check_attempts: 3,
          next_check_at: "2026-05-28T12:04:00.000Z",
        },
      }),
    );
    expect(
      db
        .prepare("select check_attempts,next_check_at from jobs where id='job-2'")
        .get(),
    ).toMatchObject({
      check_attempts: 3,
      next_check_at: "2026-05-28T12:04:00.000Z",
    });
    // An update without schedule fields preserves the existing schedule.
    project(
      db,
      makeEvent({
        actor: "core",
        entity: "job",
        lifecycle: "updated",
        item_id: ITEM,
        payload: { type: "waiting_for_pr", job_id: "job-2" },
      }),
    );
    expect(
      db.prepare("select check_attempts from jobs where id='job-2'").get()
        .check_attempts,
    ).toBe(3);
    // Closing the job removes it from the probe rotation.
    project(
      db,
      makeEvent({
        actor: "core",
        entity: "job",
        lifecycle: "closed",
        item_id: ITEM,
        payload: {
          type: "pr_opened",
          job_id: "job-2",
          status: "succeeded",
          phase: "pr_opened",
        },
      }),
    );
    expect(
      db.prepare("select next_check_at from jobs where id='job-2'").get()
        .next_check_at,
    ).toBeNull();
  });

  it("replayFold rebuilds the same state (replay-safe)", () => {
    const events = [
      itemCreated(),
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
    ];
    replayFold(db, events);
    replayFold(db, events); // folding twice = same state
    expect(db.prepare("select count(*) c from items").get().c).toBe(1);
    expect(db.prepare("select count(*) c from recommendations").get().c).toBe(
      1,
    );
  });
});
