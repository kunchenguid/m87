import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  pluginExecuteAction,
  pluginFetch,
  pluginSync,
  preparePluginWorkspace,
  readManifest,
  submitPluginWorkspace,
  syncEventsToCoreEvents,
} from "../../src/host/plugin.js";

const MOCK = fileURLToPath(
  new URL("../../plugins/mock/firstpass-src-mock.js", import.meta.url),
);

describe("host/plugin (real mock subprocess, contract v2)", () => {
  it("reads the v2 manifest", async () => {
    const m = await readManifest(MOCK);
    expect(m.plugin.id).toBe("mock");
    expect(m.protocol_version).toBe("firstpass.plugin.v2");
  });

  it("sync emits item events on first run and returns a fingerprint baseline", async () => {
    const res = await pluginSync(MOCK, { config: {}, fingerprints: {} });
    expect(res.status).toBe("complete");
    expect(res.events).toHaveLength(1);
    expect(res.events[0].lifecycle).toBe("created");
    expect(res.fingerprints["issue-1"]).toBe("fp-1");
  });

  it("sync is a pure diff: re-syncing with the baseline emits nothing", async () => {
    const first = await pluginSync(MOCK, { config: {}, fingerprints: {} });
    const second = await pluginSync(MOCK, {
      config: {},
      fingerprints: first.fingerprints,
    });
    expect(second.events).toHaveLength(0);
  });

  it("sync emits a close event when an item disappears from the source", async () => {
    const res = await pluginSync(MOCK, {
      config: { items: [] },
      fingerprints: { "issue-1": "fp-1" },
    });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].lifecycle).toBe("closed");
  });

  it("lifts plugin facts into core events with deterministic dedup keys", async () => {
    const res = await pluginSync(MOCK, { config: {}, fingerprints: {} });
    const [event] = syncEventsToCoreEvents("mock", res.events);
    expect(event.entity).toBe("item");
    expect(event.lifecycle).toBe("created");
    expect(event.actor).toBe("plugin:mock");
    expect(event.item_id).toBe("mock:issue-1");
    expect(event.attention.should_surface).toBe(true);
    expect(event.payload.type).toBe("issue_opened");
    expect(event.dedup_key).toBe("mock:issue-1:created:fp-1");
  });

  it("surfaces failure-path sync statuses", async () => {
    const rl = await pluginSync(MOCK, { config: { scenario: "rate_limited" } });
    expect(rl.status).toBe("rate_limited");
    expect(rl.retry_after_seconds).toBe(30);
  });

  it("fetches context, executes actions, and runs the automation workspace", async () => {
    const ctx = await pluginFetch(MOCK, {
      config: {},
      item_external_id: "issue-1",
    });
    expect(ctx.evidence).toHaveLength(1);

    const exec = await pluginExecuteAction(MOCK, {
      config: {},
      item_external_id: "issue-1",
      action: { id: "a1", action_type: "comment" },
      approval_id: "ap-1",
      idempotency_key: "k1",
    });
    expect(exec.status).toBe("succeeded");

    const ws = await preparePluginWorkspace(MOCK, {
      config: {},
      job: { id: "job-1" },
    });
    expect(ws.status).toBe("prepared");
    expect(ws.workspace_path).toBeTruthy();

    const sub = await submitPluginWorkspace(MOCK, {
      config: {},
      job: { id: "job-1" },
      workspace_path: ws.workspace_path,
    });
    expect(sub.status).toBe("submitted");
    expect(sub.pr_url).toContain("mock://pull/");
  });
});
