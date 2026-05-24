import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { createLoop } from "../../src/core/loop.js";
import { itemId } from "../../src/core/projections.js";
import { deadLetterCount, enqueue } from "../../src/core/queue.js";
import { readManifest } from "../../src/host/plugin.js";
import { createEffects } from "../../src/host/effects.js";
import {
  createFirstpassTestWorkspace,
  createMockAcpTarget,
} from "../support/e2e-harness.js";

const MOCK = fileURLToPath(
  new URL("../../plugins/mock/firstpass-src-mock.js", import.meta.url),
);
const ITEM = itemId("mock", "issue-1");

const AGENT_RECOMMENDATION = {
  recommendation: {
    summary: "Reply to the reporter and open a fix PR",
    evidence: [
      {
        id: "ev-1",
        kind: "event",
        source_ref: "issue-1",
        summary: "Issue opened",
      },
    ],
    options: [
      {
        title: "Reply + automated fix",
        rationale: "Acknowledge and fix the null-config crash",
        confidence: "high",
        waiting_on: "user",
        actions: [
          {
            id: "a1",
            action_type: "comment",
            params: { body: "On it." },
            required: true,
          },
        ],
        automation: {
          kind: "code_fix",
          prompt: "Guard against an empty config object.",
        },
      },
    ],
  },
  usage: { tokens_in: 100, tokens_out: 50 },
};

describe("integration: full pipeline with real mock plugin + acp-mock", () => {
  let ws;
  let db;

  beforeEach(async () => {
    ws = await createFirstpassTestWorkspace();
    db = createDatabase(`${ws.stateDir}/firstpass.sqlite`);
    const manifest = await readManifest(MOCK);
    db.prepare(
      `insert into plugins (id, binary_path, version, protocol_version, manifest_json, config_json, status, installed_at)
       values ('mock', ?, '2.0.0', 'firstpass.plugin.v2', ?, '{}', 'active', 't')`,
    ).run(MOCK, JSON.stringify(manifest));
  });

  afterEach(async () => {
    db?.close();
    await ws.cleanup();
  });

  it("syncs -> triages -> approves -> acts + fixes -> settles, all through the event log", async () => {
    const target = await createMockAcpTarget(ws, {
      response: AGENT_RECOMMENDATION,
    });
    const effects = createEffects({
      db,
      stateDir: ws.stateDir,
      config: { acp_registry_overrides: { claude: target.executablePath } },
      agentSpec: "acp:claude",
    });
    const loop = createLoop({ db, effects });

    // 1. scheduler launches a sync; the plugin diff discovers the open issue
    loop.launchEffect({ type: "sync", plugin_id: "mock" });
    await loop.settle();
    await loop.drain();

    // item folded + triaged into a live recommendation
    const item = db.prepare("select * from items where id=?").get(ITEM);
    expect(item.title).toBe("Crash on empty config");
    expect(item.local_state).toBe("recommended");
    const rec = db.prepare("select * from recommendations").get();
    expect(rec.summary).toBe("Reply to the reporter and open a fix PR");
    const agentRun = db
      .prepare("select * from agent_runs where status='completed'")
      .get();
    expect(agentRun.tokens_in).toBe(100);

    // fingerprint baseline persisted -> a second sync is a no-op (pure diff)
    expect(
      JSON.parse(
        db
          .prepare("select fingerprints_json f from plugins where id='mock'")
          .get().f,
      )["issue-1"],
    ).toBe("fp-1");

    // 2. the human gate: approve the only option
    const optionId = db
      .prepare(
        "select id from recommendation_options where recommendation_id=?",
      )
      .get(rec.id).id;
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
          recommendation_id: rec.id,
          option_id: optionId,
          decision: "approved",
        },
      }),
      { lane: "interactive" },
    );
    await loop.drain();

    // 3. action executed via the plugin; fix job opened a draft PR; item settled
    const actionResult = db
      .prepare("select * from action_results where approval_id='ap-1'")
      .get();
    expect(actionResult.status).toBe("succeeded");
    const job = db.prepare("select * from jobs where approval_id='ap-1'").get();
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.metadata_json).pr_url).toContain("mock://pull/");
    expect(
      db.prepare("select local_state from items where id=?").get(ITEM)
        .local_state,
    ).toBe("handled");

    // robustness: nothing got stuck
    expect(deadLetterCount(db)).toBe(0);

    // the immutable causal chain: everything descends from one item.created root
    const itemCreated = db
      .prepare(
        "select id from events where entity='item' and lifecycle='created'",
      )
      .get();
    const rec2 = db
      .prepare("select root_event_id from events where entity='recommendation'")
      .get();
    expect(rec2.root_event_id).toBe(itemCreated.id);
  });

  it("a closed issue on the next sync folds the item to closed", async () => {
    const target = await createMockAcpTarget(ws, {
      response: AGENT_RECOMMENDATION,
    });
    const effects = createEffects({
      db,
      stateDir: ws.stateDir,
      config: { acp_registry_overrides: { claude: target.executablePath } },
      agentSpec: "acp:claude",
    });
    const loop = createLoop({ db, effects });
    loop.launchEffect({ type: "sync", plugin_id: "mock" });
    await loop.settle();
    await loop.drain();
    expect(
      db.prepare("select state from items where id=?").get(ITEM).state,
    ).toBe("open");

    // source no longer returns the issue -> close event
    db.prepare("update plugins set config_json=? where id='mock'").run(
      JSON.stringify({ items: [] }),
    );
    loop.launchEffect({ type: "sync", plugin_id: "mock" });
    await loop.settle();
    await loop.drain();
    expect(
      db.prepare("select state from items where id=?").get(ITEM).state,
    ).toBe("closed");
  });
});
