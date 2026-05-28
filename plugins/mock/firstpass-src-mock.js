#!/usr/bin/env node
// FirstPass mock source plugin - contract v2 (emit-only-events).
//
// `sync` is a pure diff: given the fingerprint baseline core hands back, it
// emits item events (created/updated/closed) for whatever changed and returns
// the new baseline. Core folds the events; the plugin keeps no database.
//
// Deterministic by default (one open issue that should surface) so it drives
// the full triage -> approve -> action -> fix pipeline in tests/e2e. Scenarios
// can be selected via config for failure-path coverage.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROTOCOL_VERSION = "firstpass.plugin.v2";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    // Resolve on ANY stream termination, not just a clean `end`. A stranded
    // plugin whose parent died without closing stdin must never hang forever
    // eating memory, so we also resolve on `close`/`error` and cap the wait
    // with a safety timeout (the timer is unref'd so it never keeps us alive).
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach from stdin so a still-open pipe can't keep the event loop
      // referenced and block the process from exiting after we respond.
      process.stdin.removeAllListeners();
      process.stdin.pause();
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      resolve(data);
    };
    const timeoutMs =
      Number(process.env.FIRSTPASS_MOCK_STDIN_TIMEOUT_MS) || 10000;
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.stdin.on("error", finish);
    if (process.stdin.isTTY) finish();
  });
}

const MANIFEST = {
  protocol_version: PROTOCOL_VERSION,
  plugin: {
    id: "mock",
    version: "2.0.0",
    display_name: "Mock Source",
    publisher: "firstpass",
  },
  item_types: [{ type: "issue", display_name: "Mock Issue" }],
  action_types: [
    {
      type: "comment",
      display_name: "Post comment",
      safety: "external_write",
      idempotency: "idempotency_key",
    },
  ],
  capabilities: ["sync", "fetch", "actions", "automation"],
};

// The "live source" the mock reflects. Config can override `items`.
function sourceItems(config) {
  if (Array.isArray(config?.items)) {
    return config.items;
  }
  return [
    {
      external_id: "issue-1",
      item_type: "issue",
      title: "Crash on empty config",
      actor: "octocat",
      state: "open",
      url: "mock://issue/1",
      activity_at: "2026-05-20T10:00:00Z",
      activity_id: "evt-1",
      fingerprint: "fp-1",
      attention: {
        should_surface: true,
        reason: "You are assigned",
        waiting_on: "user",
        priority_hint: "normal",
      },
      payload: {
        type: "issue_opened",
        body: "App crashes when config is empty.",
      },
    },
  ];
}

function diff(config, fingerprints) {
  const events = [];
  const next = {};
  const items = sourceItems(config);
  for (const item of items) {
    next[item.external_id] = item.fingerprint;
    const prior = fingerprints?.[item.external_id];
    if (prior === undefined) {
      events.push({ ...item, lifecycle: "created" });
    } else if (prior !== item.fingerprint) {
      events.push({
        ...item,
        lifecycle: "updated",
        payload: { ...item.payload, local_state: "new" },
      });
    }
  }
  // items that disappeared from the source are closed
  for (const externalId of Object.keys(fingerprints ?? {})) {
    if (!(externalId in next)) {
      events.push({
        external_id: externalId,
        lifecycle: "closed",
        state: "closed",
        fingerprint: "closed",
        payload: { type: "issue_closed" },
      });
    }
  }
  return { events, fingerprints: next };
}

function handle(command, input) {
  const config = input.config ?? {};
  switch (command) {
    case "manifest":
      return MANIFEST;
    case "doctor":
      return {
        protocol_version: PROTOCOL_VERSION,
        status: "ok",
        checks: [],
        warnings: [],
      };
    case "configure":
      return {
        protocol_version: PROTOCOL_VERSION,
        display_name: "Mock Source",
        credentials_required: false,
        warnings: [],
      };
    case "sync": {
      if (config.scenario === "rate_limited") {
        return {
          protocol_version: PROTOCOL_VERSION,
          status: "rate_limited",
          events: [],
          fingerprints: input.fingerprints ?? {},
          retry_after_seconds: 30,
          warnings: ["rate limited"],
        };
      }
      if (config.scenario === "permission_denied") {
        return {
          protocol_version: PROTOCOL_VERSION,
          status: "permission_denied",
          events: [],
          fingerprints: input.fingerprints ?? {},
          warnings: ["permission denied"],
        };
      }
      const { events, fingerprints } = diff(config, input.fingerprints ?? {});
      return {
        protocol_version: PROTOCOL_VERSION,
        status: "complete",
        events,
        fingerprints,
        has_more: false,
        warnings: [],
      };
    }
    case "fetch":
      return {
        protocol_version: PROTOCOL_VERSION,
        human_context: {
          summary: `Mock context for ${input.item_external_id}`,
        },
        agent_context: {
          issue: input.item_external_id,
          body: "App crashes when config is empty.",
        },
        evidence: [
          {
            id: "ev-1",
            kind: "event",
            source_ref: input.item_external_id,
            summary: "Issue opened",
          },
        ],
        redaction_hints: [],
      };
    case "validate-action":
      return {
        protocol_version: PROTOCOL_VERSION,
        valid: true,
        safety: "external_write",
        warnings: [],
      };
    case "preview-action":
      return {
        protocol_version: PROTOCOL_VERSION,
        summary: "Would post a comment on the mock issue",
        preview: "Comment: Thanks, looking into this.",
        safety: "external_write",
        warnings: [],
      };
    case "execute-action":
      return {
        protocol_version: PROTOCOL_VERSION,
        status: "succeeded",
        external_result: {
          comment_url: `mock://comment/${input.action?.id ?? "a"}`,
        },
        audit_summary: "Posted mock comment",
        warnings: [],
      };
    case "prepare-automation-workspace": {
      const ws = mkdtempSync(join(tmpdir(), "firstpass-mock-ws-"));
      writeFileSync(join(ws, "README.md"), "# mock repo\n");
      return {
        protocol_version: PROTOCOL_VERSION,
        status: "prepared",
        workspace_path: ws,
        base_ref: "main",
        branch: `firstpass/fix-${input.job?.id ?? "job"}`,
        warnings: [],
      };
    }
    case "submit-automation-workspace":
      return {
        protocol_version: PROTOCOL_VERSION,
        status: "submitted",
        pr_url: `mock://pull/${input.job?.id ?? "job"}`,
        commit: "mockcommit",
        warnings: [],
      };
    default:
      return {
        protocol_version: PROTOCOL_VERSION,
        error: `unknown command: ${command}`,
      };
  }
}

async function main() {
  const command = process.argv[2];
  const raw = await readStdin();
  let input = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.stderr.write("invalid JSON input\n");
    process.exit(1);
  }
  try {
    const result = handle(command, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}

main();
