import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { project, itemId } from "../../src/core/projections.js";
import { renderInboxView } from "../../src/tui/render.js";

const ITEM = itemId("mock", "issue-1");

describe("tui/render", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-tui-"));
    db = createDatabase(join(dir, "t.sqlite"));
    db.prepare(
      `insert into plugins (id, binary_path, version, protocol_version, manifest_json, installed_at) values ('mock','/b','1','v1','{}','t')`,
    ).run();
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders an empty inbox", () => {
    const view = renderInboxView(db, { agentTarget: "acp:claude" });
    expect(view).toContain("FirstPass Inbox  (0 items)");
    expect(view).toContain("nothing waiting on you");
    expect(view).toContain("agent=acp:claude");
  });

  it("renders a surfaced recommendation with its option and selection marker", () => {
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
        },
        attention: {
          should_surface: true,
          reason: "assigned",
          waiting_on: "user",
        },
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
          summary: "Reply and fix",
          options: [
            {
              title: "Reply",
              actions: [{ id: "a1", action_type: "comment" }],
              automation: { prompt: "x" },
            },
          ],
        },
      }),
    );
    const view = renderInboxView(db, { selectedIndex: 0, agentTarget: "none" });
    expect(view).toContain("(1 item)");
    expect(view).toContain("> [0] mock:issue-1  Crash on empty config");
    expect(view).toContain("Detail: Reply and fix");
    expect(view).toContain("Reply");
    expect(view).toContain("automation");
    expect(view).toContain("rec: rec-1");
  });

  it("shows a contrib badge for contributor items and a stale badge", () => {
    project(
      db,
      makeEvent({
        actor: "plugin:mock",
        entity: "item",
        lifecycle: "created",
        item_id: ITEM,
        plugin_id: "mock",
        envelope: {
          title: "My upstream PR",
          state: "open",
          url: "u",
          fingerprint: "fp",
        },
        attention: {
          should_surface: true,
          reason: "authored",
          waiting_on: "user",
        },
        payload: {
          type: "pr_opened",
          external_id: "issue-1",
          item_type: "pull_request",
          metadata: { role: "contributor", stale: true },
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
          summary: "Wait for review",
          options: [{ title: "Wait", actions: [] }],
        },
      }),
    );
    const view = renderInboxView(db, { selectedIndex: 0, agentTarget: "none" });
    expect(view).toContain("[contrib]");
    expect(view).toContain("[stale]");
  });
});
