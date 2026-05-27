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
