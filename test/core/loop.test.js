import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { createLoop } from "../../src/core/loop.js";
import { itemId } from "../../src/core/projections.js";
import {
  deadLetterCount,
  enqueue,
  pendingCount,
} from "../../src/core/queue.js";

const ITEM = itemId("mock", "issue-1");

function seedPlugin(db) {
  db.prepare(
    `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at)
     values ('mock','/bin/mock','1','v1','{}','t')`,
  ).run();
}

const itemCreated = () =>
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
  });

// Fake effects standing in for the real plugin/agent jobs.
const fakeEffects = {
  triage: (spec, api) => {
    api.emit({
      entity: "recommendation",
      lifecycle: "created",
      payload: {
        type: "triage_result",
        recommendation_id: "rec-1",
        summary: "Reply and fix",
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
    });
  },
  action: (spec, api) => {
    api.emit({
      entity: "action",
      lifecycle: "closed",
      payload: {
        type: "executed",
        action_id: spec.action_id,
        approval_id: spec.approval_id,
        status: "succeeded",
        result: { ok: true },
      },
    });
  },
  fix: (spec, api) => {
    api.emit({
      entity: "job",
      lifecycle: "updated",
      payload: {
        type: "running",
        job_id: spec.job_id,
        status: "running",
        phase: "running_agent",
      },
    });
    api.emit({
      entity: "job",
      lifecycle: "closed",
      payload: {
        type: "pr_opened",
        job_id: spec.job_id,
        status: "succeeded",
        phase: "pr_opened",
        metadata: { pr_url: "http://pr/1" },
      },
    });
  },
};

describe("core/loop (integration)", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-loop-"));
    db = createDatabase(join(dir, "l.sqlite"));
    seedPlugin(db);
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("drives item.created -> triage -> recommendation, then approval -> action+fix -> handled", async () => {
    const loop = createLoop({ db, effects: fakeEffects });
    enqueue(db, itemCreated());
    await loop.drain();

    // triage produced a live recommendation, item surfaced
    expect(db.prepare("select count(*) c from recommendations").get().c).toBe(
      1,
    );
    expect(
      db.prepare("select local_state from items where id=?").get(ITEM)
        .local_state,
    ).toBe("recommended");

    // the human gate: approve the option
    enqueue(
      db,
      makeEvent({
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
      }),
      { lane: "interactive" },
    );
    await loop.drain();

    // action executed, fix job opened a PR, item settled to handled
    expect(
      db
        .prepare("select status from action_results where approval_id='ap-1'")
        .get().status,
    ).toBe("succeeded");
    const job = db.prepare("select * from jobs where approval_id='ap-1'").get();
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.metadata_json).pr_url).toBe("http://pr/1");
    expect(
      db.prepare("select local_state from items where id=?").get(ITEM)
        .local_state,
    ).toBe("handled");
    expect(deadLetterCount(db)).toBe(0);
  });

  it("the causal chain is preserved (all descend from the item.created root)", async () => {
    const loop = createLoop({ db, effects: fakeEffects });
    const root = itemCreated();
    enqueue(db, root);
    await loop.drain();
    const recs = db
      .prepare(
        "select root_event_id, parent_event_id, depth from events where entity='recommendation'",
      )
      .all();
    expect(recs[0].root_event_id).toBe(root.id);
    expect(recs[0].depth).toBeGreaterThan(0);
  });

  it("a poison event dead-letters after retries and does NOT wedge the loop", async () => {
    const loop = createLoop({ db, effects: fakeEffects, onError: () => {} });
    // approval referencing a missing option => gateCheck throws every time
    enqueue(
      db,
      makeEvent({
        actor: "user",
        entity: "approval",
        lifecycle: "created",
        item_id: ITEM,
        payload: {
          type: "approved",
          approval_id: "ap-x",
          recommendation_id: "rec-x",
          option_id: "missing",
        },
      }),
    );
    // a healthy event behind it
    enqueue(db, itemCreated());

    // drain repeatedly; backoff schedules the poison event into the future, so
    // run several short drains advancing past the backoff.
    for (let i = 0; i < 6; i++) {
      await loop.drain({ idleHorizonMs: 10 * 60 * 1000 });
    }
    expect(deadLetterCount(db)).toBe(1);
    // the healthy item still got processed despite the poison sibling
    expect(db.prepare("select count(*) c from items").get().c).toBe(1);
    expect(db.prepare("select count(*) c from recommendations").get().c).toBe(
      1,
    );
  });

  it("effect failures are isolated and don't crash the loop", async () => {
    const errors = [];
    const loop = createLoop({
      db,
      effects: {
        ...fakeEffects,
        triage: () => {
          throw new Error("agent down");
        },
      },
      onError: (e) => errors.push(e.message),
    });
    enqueue(db, itemCreated());
    await loop.drain();
    expect(errors).toContain("agent down");
    // item still folded; just no recommendation
    expect(db.prepare("select count(*) c from items").get().c).toBe(1);
    expect(db.prepare("select count(*) c from recommendations").get().c).toBe(
      0,
    );
    expect(pendingCount(db)).toBe(0);
  });
});
