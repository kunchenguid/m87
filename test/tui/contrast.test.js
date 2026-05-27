import React from "react";
import { beforeAll, describe, expect, it } from "vitest";

// renderToString strips color in a non-TTY test run, so to assert on the actual
// SGR codes we force chalk's color level by setting FORCE_COLOR *before* Ink (and
// its bundled chalk) is first imported. This file dynamically imports Ink inside
// beforeAll so the env var is in place when chalk initializes.
let renderToString;
let InboxView;

const h = React.createElement;

beforeAll(async () => {
  process.env.FORCE_COLOR = "3";
  delete process.env.NO_COLOR;
  ({ renderToString } = await import("ink"));
  ({ InboxView } = await import("../../src/tui/components.js"));
});

// Terminals render a base ANSI color combined with bold as its *bright* variant,
// so bold + black foreground (SGR `1` then `30`) shows up as bright-black, i.e.
// gray. Highlighted chips (text on a background) must never do this. We match the
// SGR bodies (`[1m` ... `[30m`) without the ESC prefix so the pattern carries no
// literal control characters.
const BOLD_THEN_BLACK = /\[1m(?:\[\d+m)*\[30m/;

describe("tui contrast", () => {
  it("never renders bold black foreground (which terminals promote to gray)", () => {
    const out = renderToString(
      h(InboxView, {
        model: {
          count: 1,
          selectedIndex: 0,
          items: [
            {
              index: 0,
              itemId: "mock:issue-1",
              title: "My upstream PR",
              state: "recommended",
              urgent: false,
              badges: ["contrib", "stale"],
              selected: true,
              recommendationId: "rec-1",
              optionCount: 1,
              hasAutomation: false,
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
          status: {
            agentTarget: "acp:claude",
            events: 1,
            pending: 0,
            deadLetter: 0,
          },
          daemonRunning: true,
          notice: "",
        },
        width: 100,
        height: 30,
      }),
    );
    // Sanity check the harness actually emitted color codes at all.
    expect(out).toContain("[");
    expect(BOLD_THEN_BLACK.test(out)).toBe(false);
  });
});
