import { describe, expect, it } from "vitest";

import {
  childEvent,
  ENTITIES,
  eventName,
  eventToRow,
  LIFECYCLES,
  makeEvent,
  MAX_DEPTH,
  rowToEvent,
} from "../../src/core/event.js";

describe("core/event", () => {
  it("exposes the closed vocabulary", () => {
    expect(ENTITIES).toEqual([
      "item",
      "recommendation",
      "approval",
      "action",
      "job",
    ]);
    expect(LIFECYCLES).toEqual(["created", "updated", "closed", "deleted"]);
    expect(MAX_DEPTH).toBeGreaterThan(0);
  });

  it("fills id, timestamps, and a self-rooted lineage", () => {
    const e = makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      payload: { type: "issue_opened" },
    });
    expect(e.id).toBeTruthy();
    expect(e.created_at).toBeTruthy();
    expect(e.occurred_at).toBeTruthy();
    expect(e.depth).toBe(0);
    expect(eventName(e)).toBe("item.created");
  });

  it("rejects an unknown lifecycle verb (closed vocabulary)", () => {
    expect(() =>
      makeEvent({
        actor: "core",
        entity: "item",
        lifecycle: "superseded", // must live in payload.type, not lifecycle
        payload: { type: "x" },
      }),
    ).toThrow();
  });

  it("requires payload.type (opaque body still needs a discriminator)", () => {
    expect(() =>
      makeEvent({
        actor: "core",
        entity: "item",
        lifecycle: "created",
        payload: {},
      }),
    ).toThrow();
  });

  it("childEvent inherits root, increments depth, defaults actor to core", () => {
    const parent = makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "created",
      payload: { type: "issue_opened" },
      item_id: "item-1",
    });
    const child = childEvent(parent, {
      entity: "recommendation",
      lifecycle: "created",
      payload: { type: "triage_result" },
    });
    expect(child.parent_event_id).toBe(parent.id);
    expect(child.root_event_id).toBe(parent.id);
    expect(child.depth).toBe(1);
    expect(child.actor).toBe("core");
    expect(child.item_id).toBe("item-1"); // inherited
  });

  it("round-trips through row mapping with opaque payload intact", () => {
    const e = makeEvent({
      actor: "plugin:mock",
      entity: "item",
      lifecycle: "updated",
      envelope: { title: "T", state: "open", fingerprint: "fp1" },
      attention: { should_surface: true, reason: "mentions you" },
      payload: { type: "comment_added", body: "hi", nested: { a: 1 } },
      item_id: "item-1",
      plugin_id: "mock",
    });
    const back = rowToEvent(eventToRow(e));
    expect(back).toEqual(e);
    expect(back.payload.nested.a).toBe(1);
  });
});
