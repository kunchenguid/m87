import { renderToString } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";

import { InboxView, InfoView } from "../../src/tui/components.js";

const h = React.createElement;

function render(model, dims = { width: 100, height: 30 }) {
  return renderToString(h(InboxView, { model, ...dims }));
}

const baseStatus = {
  agentTarget: "acp:claude",
  events: 12,
  pending: 0,
  deadLetter: 0,
};

describe("tui/InboxView", () => {
  it("renders the brand header and an empty-state message", () => {
    const out = render({
      count: 0,
      items: [],
      detail: null,
      status: baseStatus,
      daemonRunning: true,
      notice: "",
      selectedIndex: 0,
    });
    expect(out).toContain("firstpass");
    expect(out.toLowerCase()).toContain("inbox");
    expect(out).toContain("nothing waiting");
    // keybinding hints are always visible
    expect(out).toContain("approve");
    expect(out).toContain("quit");
  });

  it("renders an item row, its detail panel, and the agent target", () => {
    const out = render({
      count: 1,
      selectedIndex: 0,
      items: [
        {
          index: 0,
          itemId: "mock:issue-1",
          title: "Crash on empty config",
          state: "recommended",
          urgent: false,
          badges: [],
          selected: true,
          recommendationId: "rec-1",
          optionCount: 2,
          hasAutomation: true,
          confidence: "high",
        },
      ],
      detail: {
        summary: "Reply and fix",
        recommendationId: "rec-1",
        options: [
          {
            index: 0,
            title: "Reply",
            confidence: "high",
            actionCount: 1,
            hasAutomation: true,
          },
        ],
      },
      status: baseStatus,
      daemonRunning: true,
      notice: "",
    });
    expect(out).toContain("Crash on empty config");
    expect(out).toContain("Reply and fix");
    expect(out).toContain("Reply");
    expect(out).toContain("acp:claude");
  });

  it("shows badges, an urgent marker, the offline header state, and the notice", () => {
    const out = render({
      count: 1,
      selectedIndex: 0,
      items: [
        {
          index: 0,
          itemId: "mock:issue-1",
          title: "My upstream PR",
          state: "recommended",
          urgent: true,
          badges: ["contrib", "stale"],
          selected: true,
          recommendationId: "rec-1",
          optionCount: 1,
          hasAutomation: false,
          confidence: "medium",
        },
      ],
      detail: {
        summary: "Wait for review",
        recommendationId: "rec-1",
        options: [
          {
            index: 0,
            title: "Wait",
            confidence: "medium",
            actionCount: 0,
            hasAutomation: false,
          },
        ],
      },
      status: { ...baseStatus, deadLetter: 2 },
      daemonRunning: false,
      notice: "approve queued",
    });
    expect(out).toContain("contrib");
    expect(out).toContain("stale");
    expect(out).toContain("My upstream PR");
    // offline daemon is signalled by the header state, not a footer warning
    expect(out.toLowerCase()).toContain("offline");
    expect(out).toContain("approve queued");
  });

  it("renders the handle/meta line under the title", () => {
    const out = render(
      {
        count: 1,
        selectedIndex: 0,
        items: [
          {
            index: 0,
            itemId: "mock:pr-1",
            title: "chore(main): release 1.21.5",
            state: "recommended",
            urgent: false,
            badges: [],
            selected: true,
            recommendationId: "rec-1",
            optionCount: 1,
            hasAutomation: false,
            confidence: "high",
            meta: {
              handle: "kunchenguid/firstpass · PR #221",
              age: "2h",
              waiting: null,
              lead: "kunchenguid/firstpass · PR #221 · 2h",
              text: "kunchenguid/firstpass · PR #221 · 2h",
            },
          },
        ],
        detail: {
          summary: "Cut the release",
          recommendationId: "rec-1",
          options: [
            {
              index: 0,
              title: "Merge",
              confidence: "high",
              actionCount: 1,
              hasAutomation: false,
              selected: true,
              number: 1,
            },
          ],
        },
        status: baseStatus,
        daemonRunning: false,
        notice: "",
      },
      // a roomy terminal so the meta line is not truncated by the narrow pane
      { width: 120, height: 30 },
    );
    expect(out).toContain("kunchenguid/firstpass");
    expect(out).toContain("PR #221");
    expect(out).toContain("2h");
  });

  it("marks every item with a dot; urgency is shown by colour, not a triangle", () => {
    const row = (over) => ({
      index: 0,
      itemId: "mock:1",
      title: "an item",
      state: "recommended",
      urgent: false,
      badges: [],
      selected: false,
      recommendationId: "rec-1",
      optionCount: 1,
      hasAutomation: false,
      confidence: "high",
      meta: {
        handle: "repo · issue #1",
        age: "1d",
        waiting: null,
        lead: "repo · issue #1 · 1d",
        text: "repo · issue #1 · 1d",
      },
      ...over,
    });
    const out = render({
      count: 2,
      selectedIndex: 0,
      items: [
        row({
          index: 0,
          itemId: "mock:1",
          title: "a normal item",
          selected: true,
        }),
        row({
          index: 1,
          itemId: "mock:2",
          title: "an urgent item",
          urgent: true,
        }),
      ],
      detail: null,
      // daemon offline so the header reads "○ offline", not "● live" - that lets
      // us attribute the "●" to the item dot rather than the live indicator.
      status: baseStatus,
      daemonRunning: false,
      notice: "",
    });
    expect(out).toContain("●"); // every item gets a dot
    expect(out).not.toContain("▲"); // urgency is colour, not a triangle glyph
  });

  it("shows numbered options and marks the selected one without a radio dot", () => {
    const out = render({
      count: 1,
      selectedIndex: 0,
      items: [
        {
          index: 0,
          itemId: "mock:pr-1",
          title: "chore(main): release 1.21.5",
          state: "recommended",
          urgent: false,
          badges: [],
          selected: true,
          recommendationId: "rec-1",
          optionCount: 2,
          hasAutomation: false,
          confidence: "high",
          meta: { handle: null, age: null, waiting: null, text: "", lead: "" },
        },
      ],
      detail: {
        summary: "Cut the release",
        recommendationId: "rec-1",
        options: [
          {
            index: 0,
            title: "Merge",
            confidence: "high",
            actionCount: 1,
            hasAutomation: false,
            selected: false,
            number: 1,
          },
          {
            index: 1,
            title: "Hold",
            confidence: "medium",
            actionCount: 0,
            hasAutomation: false,
            selected: true,
            number: 2,
          },
        ],
      },
      status: baseStatus,
      daemonRunning: true,
      notice: "",
    });
    // the radio dots are gone; the number + highlight carry the selection
    expect(out).not.toContain("◉");
    expect(out).not.toContain("○");
    expect(out).toContain("1");
    expect(out).toContain("2");
    expect(out).toContain("Merge");
    expect(out).toContain("Hold");
  });

  it("shows the selected option's actions in a WILL DO section and drops the rec id", () => {
    const out = render({
      count: 1,
      selectedIndex: 0,
      items: [
        {
          index: 0,
          itemId: "mock:pr-1",
          title: "an item",
          state: "recommended",
          urgent: false,
          badges: [],
          selected: true,
          recommendationId: "rec-abc123",
          optionCount: 2,
          hasAutomation: true,
          confidence: "high",
          meta: { handle: null, age: null, waiting: null, text: "", lead: "" },
        },
      ],
      detail: {
        summary: "Cut the release",
        recommendationId: "rec-abc123",
        options: [
          {
            index: 0,
            number: 1,
            title: "Reply and fix",
            confidence: "high",
            actionCount: 1,
            hasAutomation: true,
            selected: true,
            actions: [{ type: "comment", preview: "Thanks for the update" }],
            automation: { kind: "code_fix", prompt: "narrow the scope" },
          },
          {
            index: 1,
            number: 2,
            title: "Hold",
            confidence: "low",
            actionCount: 0,
            hasAutomation: false,
            selected: false,
            actions: [],
            automation: null,
          },
        ],
      },
      status: baseStatus,
      daemonRunning: true,
      notice: "",
    });
    // the selected option's action detail is visible before approving
    expect(out).toContain("WILL DO");
    expect(out).toContain("comment");
    expect(out).toContain("Thanks for the update");
    expect(out).toContain("automation");
    expect(out).toContain("narrow the scope");
    // the debug recommendation id is gone
    expect(out).not.toContain("rec-abc123");
  });

  it("windows a long action preview and shows a scroll hint instead of overflowing", () => {
    const longBody = `START ${"word ".repeat(300)}TAILTOKEN`;
    const out = render(
      {
        count: 1,
        selectedIndex: 0,
        items: [
          {
            index: 0,
            itemId: "mock:pr-1",
            title: "an item",
            state: "recommended",
            urgent: false,
            badges: [],
            selected: true,
            recommendationId: "rec-1",
            optionCount: 1,
            hasAutomation: false,
            confidence: "high",
            meta: {
              handle: null,
              age: null,
              waiting: null,
              text: "",
              lead: "",
            },
          },
        ],
        detail: {
          summary: "s",
          recommendationId: "rec-1",
          options: [
            {
              index: 0,
              number: 1,
              title: "Reply",
              confidence: "high",
              actionCount: 1,
              hasAutomation: false,
              selected: true,
              actions: [{ type: "comment", preview: longBody }],
              automation: null,
            },
          ],
        },
        status: baseStatus,
        daemonRunning: true,
        notice: "",
      },
      { width: 100, height: 24 },
    );
    expect(out).toContain("START"); // the top of the body is shown
    expect(out).toContain("j/k"); // with a hint that there is more to scroll
    expect(out).not.toContain("TAILTOKEN"); // the rest is below the fold, not overflowing
  });

  it("keeps queue counts and the verbose offline warning off the main screen", () => {
    const out = render({
      count: 0,
      selectedIndex: 0,
      items: [],
      detail: null,
      status: { ...baseStatus, deadLetter: 2 },
      daemonRunning: false,
      notice: "",
    });
    // counts and the remediation command live on the info screen now
    expect(out).not.toContain("dead-letter");
    expect(out).not.toContain("daemon start");
    // but the offline state and the way to see more stay discoverable
    expect(out.toLowerCase()).toContain("offline");
    expect(out.toLowerCase()).toContain("info");
  });
});

describe("tui/InfoView", () => {
  const infoModel = (overrides = {}) => ({
    count: 3,
    selectedIndex: 0,
    items: [],
    detail: null,
    notice: "",
    daemonRunning: true,
    status: {
      agentTarget: "acp:claude",
      events: 12,
      pending: 1,
      deadLetter: 0,
    },
    ...overrides,
  });

  it("shows queue counts, the agent target, and a live daemon status", () => {
    const out = renderToString(
      h(InfoView, { model: infoModel(), width: 100, height: 30 }),
    );
    expect(out).toContain("acp:claude");
    expect(out).toContain("events");
    expect(out).toContain("pending");
    expect(out).toContain("dead-letter");
    expect(out).toContain("12");
    expect(out.toLowerCase()).toContain("live");
    // a way back is always offered
    expect(out.toLowerCase()).toContain("back");
  });

  it("surfaces the offline remediation command when the daemon is down", () => {
    const out = renderToString(
      h(InfoView, {
        model: infoModel({
          daemonRunning: false,
          status: {
            agentTarget: "acp:claude",
            events: 0,
            pending: 0,
            deadLetter: 3,
          },
        }),
        width: 100,
        height: 30,
      }),
    );
    expect(out.toLowerCase()).toContain("offline");
    expect(out).toContain("firstpass daemon start");
    expect(out).toContain("3");
  });
});
