import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import {
  loadRetentionPolicy,
  parseTtl,
  promptContextRetention,
  seedRetentionPolicy,
  sweepRetention,
} from "../../src/core/retention.js";

const NOW = new Date("2026-06-09T12:00:00.000Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function insertContext(db, { id, createdAt, expiresAt = null }) {
  db.prepare(
    `insert into prompt_contexts
       (id, item_id, recommendation_id, retention_class, human_context_json,
        agent_context_json, evidence_json, redaction_hints_json, created_at, expires_at)
     values (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "item-1",
    null,
    "prompt",
    '{"summary":"human"}',
    '{"thread":"raw source text"}',
    '[{"id":"ev-1"}]',
    "[]",
    createdAt,
    expiresAt,
  );
}

function insertRecommendation(db, { id, supersededAt = null }) {
  db.prepare(
    `insert into recommendations
       (id, item_id, summary, evidence_json, activity_at, content_fingerprint, created_at, superseded_at)
     values (?,?,?,?,?,?,?,?)`,
  ).run(id, "item-1", "s", "[]", daysAgo(40), "fp", daysAgo(40), supersededAt);
}

function insertPreview(db, { id, recommendationId, createdAt }) {
  db.prepare(
    `insert into action_previews
       (id, recommendation_id, option_id, item_id, plugin_id, action_id, action_type,
        required, depends_on_json, safety, validation_json, preview_json,
        request_json, edited_actions_json, created_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    recommendationId,
    "opt-1",
    "item-1",
    "mock",
    "a1",
    "comment",
    1,
    "[]",
    "external_write",
    "{}",
    '{"summary":"will comment"}',
    '{"action":{"params":{"body":"draft text"}}}',
    "[]",
    createdAt,
  );
}

function insertEvent(db, { id, entity, lifecycle, createdAt, payload }) {
  db.prepare(
    `insert into events (id, actor, occurred_at, created_at, entity, lifecycle, payload_json, item_id)
     values (?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "core",
    createdAt,
    createdAt,
    entity,
    lifecycle,
    JSON.stringify(payload),
    "item-1",
  );
}

function insertActionResult(db, { id, completedAt }) {
  db.prepare(
    `insert into action_results
       (id, approval_id, item_id, plugin_id, action_id, action_type, required,
        depends_on_json, safety, status, validation_json, preview_json,
        request_json, result_json, completed_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "approval-1",
    "item-1",
    "mock",
    "a1",
    "comment",
    1,
    "[]",
    "external_write",
    "succeeded",
    "{}",
    '{"summary":"sent"}',
    '{"action":{"params":{"body":"outgoing text"}}}',
    '{"url":"mock://comment/1"}',
    completedAt,
  );
}

describe("core/retention", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m87-retention-"));
    db = createDatabase(join(dir, "r.sqlite"));
    seedRetentionPolicy(db);
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("parseTtl", () => {
    it("parses day and hour durations", () => {
      expect(parseTtl("7d")).toEqual({ ms: 7 * 86_400_000 });
      expect(parseTtl("12h")).toEqual({ ms: 12 * 3_600_000 });
    });

    it("parses keep and never", () => {
      expect(parseTtl("keep")).toEqual({ keep: true });
      expect(parseTtl("never")).toEqual({ never: true });
    });

    it("rejects everything else", () => {
      for (const bad of ["", "7", "d7", "7w", "soon", null]) {
        expect(() => parseTtl(bad)).toThrow(/invalid ttl/);
      }
    });
  });

  it("seeds one default policy row, idempotently", () => {
    seedRetentionPolicy(db);
    const policy = loadRetentionPolicy(db);
    expect(policy.prompt_ttl).toBe("30d");
    expect(policy.raw_context_ttl).toBe("7d");
    expect(policy.audit_ttl).toBe("365d");
  });

  it("purges raw agent context after raw_context_ttl, keeping rendered context", () => {
    insertContext(db, { id: "ctx-old", createdAt: daysAgo(10) });
    insertContext(db, { id: "ctx-new", createdAt: daysAgo(1) });

    const counts = sweepRetention(db, { now: NOW });
    expect(counts.raw_contexts).toBe(1);

    const old = db
      .prepare("select * from prompt_contexts where id='ctx-old'")
      .get();
    expect(old.agent_context_json).toBe("null");
    expect(old.human_context_json).toBe('{"summary":"human"}');
    expect(old.deleted_at).toBeNull();
    const fresh = db
      .prepare("select * from prompt_contexts where id='ctx-new'")
      .get();
    expect(fresh.agent_context_json).toBe('{"thread":"raw source text"}');
  });

  it("purges whole prompt contexts after prompt_ttl, leaving a tombstone", () => {
    insertContext(db, { id: "ctx-old", createdAt: daysAgo(40) });

    const counts = sweepRetention(db, { now: NOW });
    expect(counts.prompt_contexts).toBe(1);

    const old = db
      .prepare("select * from prompt_contexts where id='ctx-old'")
      .get();
    expect(old.deleted_at).not.toBeNull();
    expect(old.human_context_json).toBe("null");
    expect(old.agent_context_json).toBe("null");
    expect(old.evidence_json).toBe("null");
  });

  it("honors a per-row expires_at even when the policy says keep", () => {
    db.prepare(
      "update retention_policies set prompt_ttl='keep', raw_context_ttl='keep'",
    ).run();
    insertContext(db, {
      id: "ctx-promised",
      createdAt: daysAgo(2),
      expiresAt: daysAgo(1),
    });

    const counts = sweepRetention(db, { now: NOW });
    expect(counts.prompt_contexts).toBe(1);
  });

  it("never-retention purges immediately; keep retains forever", () => {
    db.prepare("update retention_policies set prompt_ttl='never'").run();
    insertContext(db, { id: "ctx-now", createdAt: NOW.toISOString() });
    expect(sweepRetention(db, { now: NOW }).prompt_contexts).toBe(1);

    db.prepare("update retention_policies set prompt_ttl='keep'").run();
    insertContext(db, { id: "ctx-ancient", createdAt: daysAgo(900) });
    const counts = sweepRetention(db, { now: NOW });
    expect(counts.prompt_contexts).toBe(0);
  });

  it("deletes old drafts only when their recommendation is superseded", () => {
    insertRecommendation(db, { id: "rec-live" });
    insertRecommendation(db, { id: "rec-done", supersededAt: daysAgo(35) });
    insertPreview(db, {
      id: "p-live",
      recommendationId: "rec-live",
      createdAt: daysAgo(40),
    });
    insertPreview(db, {
      id: "p-done-old",
      recommendationId: "rec-done",
      createdAt: daysAgo(40),
    });
    insertPreview(db, {
      id: "p-done-new",
      recommendationId: "rec-done",
      createdAt: daysAgo(2),
    });
    insertPreview(db, {
      id: "p-orphan",
      recommendationId: "rec-gone",
      createdAt: daysAgo(40),
    });

    const counts = sweepRetention(db, { now: NOW });
    expect(counts.drafts).toBe(2);
    const left = db
      .prepare("select id from action_previews order by id")
      .all()
      .map((r) => r.id);
    expect(left).toEqual(["p-done-new", "p-live"]);
  });

  it("compacts audit payloads after audit_ttl, keeping the record skeleton", () => {
    insertActionResult(db, { id: "ar-old", completedAt: daysAgo(400) });
    insertActionResult(db, { id: "ar-new", completedAt: daysAgo(10) });

    const counts = sweepRetention(db, { now: NOW });
    expect(counts.audit_payloads).toBe(1);

    const old = db
      .prepare("select * from action_results where id='ar-old'")
      .get();
    expect(old.request_json).toBe("{}");
    expect(old.result_json).toBeNull();
    expect(old.status).toBe("succeeded");
    expect(old.completed_at).toBe(daysAgo(400));
    const fresh = db
      .prepare("select * from action_results where id='ar-new'")
      .get();
    expect(fresh.request_json).toContain("outgoing text");
  });

  it("redacts old action event payloads to the replayable skeleton", () => {
    insertActionResult(db, { id: "approval-1:a1", completedAt: daysAgo(400) });
    insertEvent(db, {
      id: "ev-act-old",
      entity: "action",
      lifecycle: "created",
      createdAt: daysAgo(400),
      payload: {
        type: "queued",
        action_id: "a1",
        approval_id: "approval-1",
        action_type: "comment",
        required: true,
        safety: "external_write",
        request: { action: { params: { body: "outgoing text" } } },
      },
    });
    insertEvent(db, {
      id: "ev-act-new",
      entity: "action",
      lifecycle: "closed",
      createdAt: daysAgo(10),
      payload: { type: "executed", action_id: "a1", result: { url: "u" } },
    });

    const counts = sweepRetention(db, { now: NOW });
    expect(counts.audit_events).toBe(1);

    const old = JSON.parse(
      db.prepare("select payload_json from events where id='ev-act-old'").get()
        .payload_json,
    );
    expect(old).toEqual({
      redacted: true,
      type: "queued",
      action_id: "a1",
      approval_id: "approval-1",
      action_type: "comment",
      required: true,
      safety: "external_write",
    });
    const fresh = JSON.parse(
      db.prepare("select payload_json from events where id='ev-act-new'").get()
        .payload_json,
    );
    expect(fresh.result).toEqual({ url: "u" });
  });

  it("keeps queued action event payloads until processing completes", () => {
    db.prepare("update retention_policies set audit_ttl='never'").run();
    insertEvent(db, {
      id: "ev-act-pending",
      entity: "action",
      lifecycle: "created",
      createdAt: NOW.toISOString(),
      payload: {
        type: "queued",
        action_id: "a1",
        approval_id: "approval-1",
        request: { action: { params: { body: "outgoing text" } } },
      },
    });
    db.prepare(
      `insert into queue (id, event_id, available_at, lane, attempts, status, created_at)
       values ('q-act-pending', 'ev-act-pending', ?, 'default', 0, 'pending', ?)`,
    ).run(NOW.toISOString(), NOW.toISOString());

    const counts = sweepRetention(db, { now: NOW });
    expect(counts.audit_events).toBe(0);

    const payload = JSON.parse(
      db.prepare("select payload_json from events where id='ev-act-pending'").get()
        .payload_json,
    );
    expect(payload.request.action.params.body).toBe("outgoing text");
  });

  it("redacts draft payloads from superseded recommendations and their events", () => {
    insertRecommendation(db, { id: "rec-live" });
    insertRecommendation(db, { id: "rec-done", supersededAt: daysAgo(35) });
    for (const recId of ["rec-live", "rec-done"]) {
      db.prepare(
        `insert into recommendation_options
           (id, recommendation_id, position, title, rationale, evidence_refs_json,
            confidence, waiting_on, actions_json, automation_json, created_at)
         values (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `${recId}-opt-0`,
        recId,
        0,
        "Reply",
        "ack",
        "[]",
        "high",
        "user",
        '[{"id":"a1","params":{"body":"draft text"}}]',
        '{"kind":"code_fix","prompt":"fix it"}',
        daysAgo(40),
      );
      insertEvent(db, {
        id: `ev-${recId}`,
        entity: "recommendation",
        lifecycle: "created",
        createdAt: daysAgo(40),
        payload: {
          type: "triage_result",
          recommendation_id: recId,
          summary: "Reply and fix",
          options: [
            {
              id: `${recId}-opt-0`,
              title: "Reply",
              actions: [{ id: "a1", params: { body: "draft text" } }],
              automation: { kind: "code_fix", prompt: "fix it" },
            },
          ],
        },
      });
    }

    const counts = sweepRetention(db, { now: NOW });
    expect(counts.draft_options).toBe(1);

    const done = db
      .prepare("select * from recommendation_options where id='rec-done-opt-0'")
      .get();
    expect(done.actions_json).toBe("[]");
    expect(done.automation_json).toBeNull();
    expect(done.title).toBe("Reply");
    const live = db
      .prepare("select * from recommendation_options where id='rec-live-opt-0'")
      .get();
    expect(live.actions_json).toContain("draft text");

    const doneEvent = JSON.parse(
      db.prepare("select payload_json from events where id='ev-rec-done'").get()
        .payload_json,
    );
    expect(doneEvent.drafts_redacted).toBe(true);
    expect(doneEvent.summary).toBe("Reply and fix");
    expect(doneEvent.options[0].actions).toEqual([]);
    expect(doneEvent.options[0].automation).toBeNull();
    expect(doneEvent.options[0].title).toBe("Reply");
    const liveEvent = JSON.parse(
      db.prepare("select payload_json from events where id='ev-rec-live'").get()
        .payload_json,
    );
    expect(liveEvent.options[0].actions[0].params.body).toBe("draft text");
  });

  it("removes attachment files past attachment_ttl, keeping fresh ones", () => {
    const attachments = join(dir, "attachments", "item-1");
    mkdirSync(attachments, { recursive: true });
    const oldFile = join(attachments, "old.bin");
    const newFile = join(attachments, "new.bin");
    writeFileSync(oldFile, "old");
    writeFileSync(newFile, "new");
    const oldTime = new Date(NOW.getTime() - 10 * 86_400_000);
    utimesSync(oldFile, oldTime, oldTime);

    const counts = sweepRetention(db, { stateDir: dir, now: NOW });
    expect(counts.attachments).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it("sweeps repeatedly without recounting already-purged rows", () => {
    insertContext(db, { id: "ctx-old", createdAt: daysAgo(40) });
    insertActionResult(db, { id: "ar-old", completedAt: daysAgo(400) });
    insertEvent(db, {
      id: "ev-act-old",
      entity: "action",
      lifecycle: "created",
      createdAt: daysAgo(400),
      payload: {
        type: "queued",
        action_result_id: "ar-old",
        action_id: "a1",
        approval_id: "approval-1",
        request: { x: 1 },
      },
    });
    sweepRetention(db, { now: NOW });
    const second = sweepRetention(db, { now: NOW });
    expect(second).toEqual({
      raw_contexts: 0,
      prompt_contexts: 0,
      drafts: 0,
      draft_options: 0,
      attachments: 0,
      audit_payloads: 0,
      audit_events: 0,
    });
  });

  describe("promptContextRetention", () => {
    it("stamps expires_at from prompt_ttl", () => {
      const r = promptContextRetention(db, NOW);
      expect(r.store).toBe(true);
      expect(r.expires_at).toBe(
        new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
      );
    });

    it("keep stores without expiry; never does not store", () => {
      db.prepare("update retention_policies set prompt_ttl='keep'").run();
      expect(promptContextRetention(db, NOW)).toEqual({
        store: true,
        expires_at: null,
      });
      db.prepare("update retention_policies set prompt_ttl='never'").run();
      expect(promptContextRetention(db, NOW)).toEqual({
        store: false,
        expires_at: null,
      });
    });
  });
});
