import { z } from "zod";

// The plugin protocol (contract v2). Plugins are boring subprocesses speaking
// JSON over stdio. The headline change from v1: `sync` emits ONLY events (a
// pure diff), never items. Core holds the fingerprint baseline and folds the
// events into item projections itself (plan §7).

export const PROTOCOL_VERSION = "firstpass.plugin.v2";

// --- manifest --------------------------------------------------------------
export const manifestSchema = z
  .object({
    protocol_version: z.string(),
    plugin: z.object({
      id: z.string(),
      version: z.string(),
      display_name: z.string().optional(),
      publisher: z.string().optional(),
    }),
    requested_scopes: z.array(z.any()).optional(),
    item_types: z.array(z.any()).optional(),
    action_types: z.array(z.any()).optional(),
    capabilities: z.array(z.any()).optional(),
    trust: z.any().optional(),
  })
  .passthrough();

// --- a plugin-emitted fact -------------------------------------------------
// Flat, source-neutral shell + opaque payload. The host lifts this into a full
// core event (assigning id/lineage, deriving item_id and dedup_key).
export const pluginEventSchema = z
  .object({
    entity: z.enum(["item"]).default("item"),
    lifecycle: z.enum(["created", "updated", "closed", "deleted"]),
    external_id: z.string(),
    item_type: z.string().optional(),
    title: z.string().optional(),
    actor: z.string().optional(),
    state: z.string().optional(),
    url: z.string().optional(),
    activity_at: z.string().optional(),
    activity_id: z.string().optional(),
    fingerprint: z.string().optional(),
    attention: z
      .object({
        should_surface: z.boolean().optional(),
        reason: z.string().optional(),
        waiting_on: z.string().optional(),
        priority_hint: z.string().optional(),
      })
      .passthrough()
      .optional(),
    payload: z.object({ type: z.string() }).passthrough(),
    occurred_at: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    local_state: z.string().optional(),
  })
  .passthrough();

// --- sync (v2) -------------------------------------------------------------
// input:  { config, fingerprints }
// output: { protocol_version, status, events:[pluginEvent], fingerprints, has_more?, warnings, retry_after_seconds? }
export const syncResponseSchema = z
  .object({
    protocol_version: z.string().optional(),
    status: z
      .enum([
        "complete",
        "partial",
        "rate_limited",
        "permission_denied",
        "error",
      ])
      .default("complete"),
    events: z.array(pluginEventSchema).default([]),
    fingerprints: z.record(z.string(), z.any()).default({}),
    has_more: z.boolean().optional(),
    retry_after_seconds: z.number().optional(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

// --- fetch context ---------------------------------------------------------
export const fetchContextResponseSchema = z
  .object({
    protocol_version: z.string().optional(),
    human_context: z.any().default({}),
    agent_context: z.any().default({}),
    evidence: z.array(z.any()).default([]),
    redaction_hints: z.array(z.any()).default([]),
  })
  .passthrough();

// --- actions ---------------------------------------------------------------
export const actionValidationResponseSchema = z
  .object({
    valid: z.boolean().default(true),
    safety: z.string().default("safe"),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

export const actionPreviewResponseSchema = z
  .object({
    summary: z.string().default(""),
    preview: z.string().default(""),
    safety: z.string().default("safe"),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

export const actionExecutionResponseSchema = z
  .object({
    status: z
      .enum(["succeeded", "failed", "already_applied"])
      .default("succeeded"),
    external_result: z.any().optional(),
    audit_summary: z.string().optional(),
    error: z.string().optional(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

// --- automation (fix job) --------------------------------------------------
export const prepareWorkspaceResponseSchema = z
  .object({
    status: z.enum(["prepared", "failed"]).default("prepared"),
    workspace_path: z.string().optional(),
    base_ref: z.string().optional(),
    branch: z.string().optional(),
    error: z.string().optional(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

export const submitWorkspaceResponseSchema = z
  .object({
    status: z
      .enum(["submitted", "no_changes", "failed", "waiting_for_pr"])
      .default("submitted"),
    pr_url: z.string().optional(),
    commit: z.string().optional(),
    branch: z.string().optional(),
    repository: z.string().optional(),
    error: z.string().optional(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

// Re-detect a fix PR after a push where detection initially missed (FU-15).
export const detectPrResponseSchema = z
  .object({
    status: z
      .enum(["submitted", "waiting_for_pr", "failed"])
      .default("waiting_for_pr"),
    pr_url: z.string().optional(),
    error: z.string().optional(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

export const configureResponseSchema = z
  .object({
    display_name: z.string().optional(),
    credentials_required: z.boolean().optional(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

export const doctorResponseSchema = z
  .object({
    status: z.string().default("ok"),
    checks: z.array(z.any()).default([]),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();
