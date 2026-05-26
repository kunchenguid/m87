import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { makeEvent } from "../core/event.js";
import { itemId } from "../core/projections.js";
import {
  actionExecutionResponseSchema,
  actionPreviewResponseSchema,
  actionValidationResponseSchema,
  configureResponseSchema,
  detectPrResponseSchema,
  doctorResponseSchema,
  fetchContextResponseSchema,
  manifestSchema,
  prepareWorkspaceResponseSchema,
  PROTOCOL_VERSION,
  submitWorkspaceResponseSchema,
  syncResponseSchema,
} from "./protocol.js";

export class PluginError extends Error {
  constructor(command, message) {
    super(message);
    this.name = "PluginError";
    this.command = command;
  }
}

export class PluginTrustDriftError extends Error {
  constructor(pluginId, reason) {
    super(reason);
    this.name = "PluginTrustDriftError";
    this.pluginId = pluginId;
  }
}

/**
 * Spawn a plugin subprocess, hand it one JSON line on stdin, and parse one JSON
 * object from stdout. Falls back to `node <binary>` when the file isn't directly
 * executable (ENOEXEC). The trust boundary (invariant IV) lives here: plugins
 * are subprocesses that return data; they never drive control.
 */
export async function runPluginCommand(binaryPath, command, input) {
  const args = [command, "--protocol-version", PROTOCOL_VERSION];
  const exec = (executable, execArgs) =>
    new Promise((resolve, reject) => {
      const child = spawn(executable, execArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const err = Object.assign(
          new Error(stderr.trim() || `plugin command failed: ${command}`),
          { stderr },
        );
        reject(err);
      });
      child.stdin.end(`${JSON.stringify(input ?? {})}\n`);
    });

  let stdout;
  try {
    // Launch JS plugins under the current Node directly. Spawning the .js file
    // itself relies on a POSIX shebang, which Windows cannot exec; going through
    // process.execPath is portable and pins the plugin to our Node. Other
    // binaries (.exe, native) are executed directly.
    stdout = /\.[mc]?js$/i.test(binaryPath)
      ? await exec(process.execPath, [binaryPath, ...args])
      : await exec(binaryPath, args);
  } catch (err) {
    // A non-executable script on POSIX surfaces as ENOEXEC; fall back to Node.
    if (err?.code === "ENOEXEC") {
      stdout = await exec(process.execPath, [binaryPath, ...args]);
    } else {
      throw new PluginError(command, err?.stderr?.trim() || err.message);
    }
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new PluginError(
      command,
      `plugin returned invalid JSON for ${command}`,
    );
  }
}

async function runValidated(binaryPath, command, input, schema) {
  const raw = await runPluginCommand(binaryPath, command, input);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new PluginError(
      command,
      `plugin returned invalid ${command} response: ${result.error.issues[0]?.message}`,
    );
  }
  return result.data;
}

// --- trust -----------------------------------------------------------------

export async function pluginBinaryHash(binaryPath) {
  return createHash("sha256")
    .update(await readFile(binaryPath))
    .digest("hex");
}

export async function assertTrustUnchanged(pluginRecord) {
  const { id, binary_path: binaryPath, binary_hash: storedHash } = pluginRecord;
  if (!binaryPath) {
    throw new PluginTrustDriftError(id, "plugin binary path is missing");
  }
  if (storedHash) {
    const current = await pluginBinaryHash(binaryPath);
    if (current !== storedHash) {
      throw new PluginTrustDriftError(id, "plugin binary hash changed");
    }
  }
}

// --- commands --------------------------------------------------------------

export function readManifest(binaryPath) {
  return runValidated(binaryPath, "manifest", {}, manifestSchema);
}

export function pluginDoctor(binaryPath, config = {}) {
  return runValidated(binaryPath, "doctor", { config }, doctorResponseSchema);
}

export function pluginConfigure(binaryPath, config) {
  return runValidated(
    binaryPath,
    "configure",
    { config },
    configureResponseSchema,
  );
}

export function pluginSync(
  binaryPath,
  { config = {}, fingerprints = {} } = {},
) {
  return runValidated(
    binaryPath,
    "sync",
    { config, fingerprints },
    syncResponseSchema,
  );
}

export function pluginFetch(binaryPath, { config = {}, item_external_id }) {
  return runValidated(
    binaryPath,
    "fetch",
    { config, item_external_id },
    fetchContextResponseSchema,
  );
}

export function pluginValidateAction(binaryPath, request) {
  return runValidated(
    binaryPath,
    "validate-action",
    request,
    actionValidationResponseSchema,
  );
}

export function pluginPreviewAction(binaryPath, request) {
  return runValidated(
    binaryPath,
    "preview-action",
    request,
    actionPreviewResponseSchema,
  );
}

export function pluginExecuteAction(binaryPath, request) {
  return runValidated(
    binaryPath,
    "execute-action",
    request,
    actionExecutionResponseSchema,
  );
}

export function preparePluginWorkspace(binaryPath, request) {
  return runValidated(
    binaryPath,
    "prepare-automation-workspace",
    request,
    prepareWorkspaceResponseSchema,
  );
}

export function submitPluginWorkspace(binaryPath, request) {
  return runValidated(
    binaryPath,
    "submit-automation-workspace",
    request,
    submitWorkspaceResponseSchema,
  );
}

export function detectPluginPr(binaryPath, request) {
  return runValidated(
    binaryPath,
    "detect-automation-pr",
    request,
    detectPrResponseSchema,
  );
}

// --- sync diff -> core events ----------------------------------------------

/**
 * Lift a plugin-emitted fact into a full core event: assign actor/item_id and
 * a deterministic dedup_key so the same source state is never double-ingested
 * (idempotent ingestion, invariant VI). The opaque source detail is preserved
 * in payload; the flat shell becomes envelope + attention.
 */
export function pluginEventToCoreEvent(pluginId, pe) {
  const id = itemId(pluginId, pe.external_id);
  const fingerprint = pe.fingerprint ?? pe.activity_id ?? "";
  return makeEvent({
    actor: `plugin:${pluginId}`,
    occurred_at: pe.occurred_at ?? pe.activity_at,
    entity: "item",
    lifecycle: pe.lifecycle,
    item_id: id,
    plugin_id: pluginId,
    envelope: {
      title: pe.title,
      state: pe.state,
      url: pe.url,
      activity_at: pe.activity_at,
      activity_id: pe.activity_id,
      fingerprint: pe.fingerprint,
    },
    attention: pe.attention ?? null,
    payload: {
      ...pe.payload,
      external_id: pe.external_id,
      item_type: pe.item_type ?? pe.payload?.item_type ?? "item",
      actor: pe.actor,
      metadata: pe.metadata ?? {},
      ...(pe.local_state ? { local_state: pe.local_state } : {}),
    },
    dedup_key: `${pluginId}:${pe.external_id}:${pe.lifecycle}:${fingerprint}`,
  });
}

export function syncEventsToCoreEvents(pluginId, events) {
  return events.map((pe) => pluginEventToCoreEvent(pluginId, pe));
}
