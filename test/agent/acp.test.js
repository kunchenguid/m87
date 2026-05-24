import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectAgentSpec,
  resolveEffectiveAgentSpec,
} from "../../src/agent/detect.js";
import { parseAcpJsonOutput, runAcpTurn } from "../../src/agent/acp.js";
import {
  createFirstpassTestWorkspace,
  createMockAcpTarget,
} from "../support/e2e-harness.js";

describe("agent/detect", () => {
  it("returns the explicit acp target from config", () => {
    expect(resolveEffectiveAgentSpec({ agent: "acp:claude" })).toBe(
      "acp:claude",
    );
  });
  it("returns null when no provider is on an empty probe path", () => {
    const prev = process.env.FIRSTPASS_AGENT_PROBE_PATH;
    process.env.FIRSTPASS_AGENT_PROBE_PATH = "";
    expect(detectAgentSpec()).toBeNull();
    process.env.FIRSTPASS_AGENT_PROBE_PATH = prev;
  });
});

describe("agent/acp parseAcpJsonOutput", () => {
  it("parses bare JSON", () => {
    expect(parseAcpJsonOutput('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses fenced JSON", () => {
    expect(parseAcpJsonOutput('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it("throws on empty output", () => {
    expect(() => parseAcpJsonOutput("")).toThrow();
  });
});

describe("agent/acp runAcpTurn (real acp-mock)", () => {
  let ws;
  beforeEach(async () => {
    ws = await createFirstpassTestWorkspace();
  });
  afterEach(async () => {
    await ws.cleanup();
  });

  it("runs a turn against a mock ACP target and returns parsed JSON", async () => {
    const recommendation = {
      recommendation: {
        summary: "Reply and open a fix",
        evidence: [],
        options: [
          {
            title: "Reply",
            rationale: "",
            confidence: "high",
            waiting_on: "user",
            actions: [{ id: "a1", action_type: "comment", params: {} }],
          },
        ],
      },
      usage: { tokens_in: 42 },
    };
    const target = await createMockAcpTarget(ws, { response: recommendation });
    const { response } = await runAcpTurn({
      agentSpec: "acp:claude",
      config: { acp_registry_overrides: { claude: target.executablePath } },
      stateDir: ws.stateDir,
      sessionKey: "session-test",
      promptText: "produce a recommendation",
    });
    expect(response.recommendation.summary).toBe("Reply and open a fix");
    expect(response.recommendation.options[0].actions[0].action_type).toBe(
      "comment",
    );
  });
});
