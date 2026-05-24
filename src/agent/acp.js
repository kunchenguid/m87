import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
} from "acpx/runtime";

// The agent boundary (invariant IV): the agent is reachable ONLY from core
// (handlers/jobs), never from plugins. It is the data-egress path and stays
// behind the trust line. Everything here is core-internal.

export function redactAcpTarget(agentSpec) {
  if (typeof agentSpec !== "string") {
    return null;
  }
  const target = agentSpec.slice("acp:".length);
  return /\s/.test(target) ? "acp:custom" : agentSpec;
}

export function estimateTokenCount(value) {
  const serialized = JSON.stringify(value);
  return typeof serialized === "string"
    ? Math.max(1, Math.ceil(serialized.length / 4))
    : 0;
}

export function parseAcpJsonOutput(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("ACP target returned no output text");
  }
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // tolerant extraction for fenced / prose-wrapped output
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("ACP target returned invalid JSON");
}

async function createAcpRuntimeContext(config, stateDir, cwd = process.cwd()) {
  const overrides =
    config && typeof config === "object" ? config.acp_registry_overrides : null;
  // Isolate the session store per turn. We never resume an ACP session (each
  // run uses a fresh session key), and a shared file store leaks stale session
  // bindings across separate CLI processes, which makes the agent skip
  // re-authentication on a fresh subprocess ("Authentication required").
  const sessionStateDir = join(stateDir, "acp-sessions", randomUUID());
  await mkdir(sessionStateDir, { recursive: true });
  const sessionStore = createFileSessionStore({ stateDir: sessionStateDir });
  const agentRegistry = createAgentRegistry(
    overrides && typeof overrides === "object" && !Array.isArray(overrides)
      ? { overrides }
      : undefined,
  );
  return {
    sessionStateDir,
    runtime: createAcpRuntime({
      cwd,
      sessionStore,
      agentRegistry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    }),
  };
}

/**
 * Run one agent turn against an ACP target. Returns { response, usage,
 * outputText }. When parseJson is false (e.g. a fix job that edits a workspace
 * and need not return JSON) the raw outputText is returned without parsing.
 */
export async function runAcpTurn({
  agentSpec,
  config = {},
  stateDir,
  sessionKey,
  promptText,
  cwd = process.cwd(),
  parseJson = true,
  signal = undefined,
}) {
  if (typeof agentSpec !== "string" || !agentSpec.startsWith("acp:")) {
    throw new Error("agent must be an acp target");
  }
  const targetCommand = agentSpec.slice("acp:".length).trim();
  if (!targetCommand) {
    throw new Error("agent target is empty");
  }
  const { runtime, sessionStateDir } = await createAcpRuntimeContext(
    config,
    stateDir,
    cwd,
  );
  let handle;
  let onAbort;
  try {
    handle = await runtime.ensureSession({
      sessionKey: sessionKey ?? `session-${randomUUID()}`,
      agent: targetCommand,
      mode: "persistent",
      cwd,
    });
    // On a daemon shutdown, close the session so the agent subprocess is torn
    // down instead of holding the event loop open with a half-finished turn.
    if (signal) {
      onAbort = () => {
        runtime
          .close({ handle, reason: "firstpass-aborted" })
          .catch(() => undefined);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    const turn = runtime.startTurn({
      handle,
      text: promptText,
      mode: "prompt",
      requestId: randomUUID(),
    });
    let outputText = "";
    let latestUsed;
    for await (const event of turn.events) {
      if (
        event.type === "text_delta" &&
        (event.stream ?? "output") === "output"
      ) {
        outputText += event.text;
      } else if (event.type === "status" && typeof event.used === "number") {
        latestUsed = event.used;
      }
    }
    const result = await turn.result;
    if (result.status !== "completed") {
      throw new Error(
        result.status === "failed" ? result.error.message : "ACP target failed",
      );
    }
    let response = null;
    if (parseJson) {
      response = parseAcpJsonOutput(outputText);
    }
    const usage =
      response && typeof response === "object" && response.usage
        ? response.usage
        : latestUsed !== undefined
          ? { tokens_in: latestUsed }
          : {};
    return { response, usage, outputText };
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    if (handle !== undefined) {
      await runtime
        .close({ handle, reason: "firstpass-turn-complete" })
        .catch(() => undefined);
    }
    await rm(sessionStateDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
