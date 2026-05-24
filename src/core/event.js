import { randomUUID } from "node:crypto";

import { z } from "zod";

// The event vocabulary (plan §2, §4). The OUTER shell is core-owned and
// core-understood; the inner `payload` is OPAQUE to core (the agent's
// evidence). Core branches only on `entity` + `lifecycle`; the source's own
// type-name lives in `payload.type`.

export const ENTITIES = Object.freeze([
  "item",
  "recommendation",
  "approval",
  "action",
  "job",
]);

// Closed vocabulary. The specific transition (superseded, pr_opened, dismissed)
// rides in payload.type, never as a new lifecycle verb.
export const LIFECYCLES = Object.freeze([
  "created",
  "updated",
  "closed",
  "deleted",
]);

// Strict-priority lanes (plan §6). Interactive (human/approval/result) must not
// wait behind a fresh background sync batch.
export const LANES = Object.freeze(["interactive", "default", "background"]);

// Cascade-budget guard (invariant VII): no event tree may grow past this depth.
export const MAX_DEPTH = 32;

const envelopeSchema = z
  .object({
    title: z.string().optional(),
    state: z.string().optional(),
    url: z.string().optional(),
    activity_at: z.string().optional(),
    activity_id: z.string().optional(),
    fingerprint: z.string().optional(),
  })
  .passthrough();

const attentionSchema = z
  .object({
    should_surface: z.boolean().optional(),
    reason: z.string().optional(),
    waiting_on: z.string().optional(),
    priority_hint: z.string().optional(),
  })
  .passthrough();

// payload is opaque to core; we only require a `type` discriminator inside it.
const payloadSchema = z.object({ type: z.string() }).passthrough();

export const eventInputSchema = z.object({
  id: z.string().optional(),
  actor: z.string(),
  occurred_at: z.string().optional(),
  created_at: z.string().optional(),
  entity: z.enum(ENTITIES),
  lifecycle: z.enum(LIFECYCLES),
  envelope: envelopeSchema.nullish(),
  attention: attentionSchema.nullish(),
  payload: payloadSchema,
  item_id: z.string().nullish(),
  plugin_id: z.string().nullish(),
  parent_event_id: z.string().nullish(),
  root_event_id: z.string().nullish(),
  depth: z.number().int().nonnegative().optional(),
  schema_version: z.number().int().positive().optional(),
  dedup_key: z.string().nullish(),
});

/**
 * Construct a validated, fully-populated event from partial input. Fills id,
 * timestamps, and lineage defaults. Does not touch the DB.
 */
export function makeEvent(input) {
  const parsed = eventInputSchema.parse(input);
  const now = new Date().toISOString();
  return {
    id: parsed.id ?? randomUUID(),
    actor: parsed.actor,
    occurred_at: parsed.occurred_at ?? now,
    created_at: parsed.created_at ?? now,
    entity: parsed.entity,
    lifecycle: parsed.lifecycle,
    envelope: parsed.envelope ?? null,
    attention: parsed.attention ?? null,
    payload: parsed.payload,
    item_id: parsed.item_id ?? null,
    plugin_id: parsed.plugin_id ?? null,
    parent_event_id: parsed.parent_event_id ?? null,
    root_event_id: parsed.root_event_id ?? parsed.id ?? null,
    depth: parsed.depth ?? 0,
    schema_version: parsed.schema_version ?? 1,
    dedup_key: parsed.dedup_key ?? null,
  };
}

/**
 * Construct a child event caused by `parent`. Inherits the causal root,
 * increments depth (budget guard), and defaults the actor to "core".
 */
export function childEvent(parent, input) {
  const id = input.id ?? randomUUID();
  const event = makeEvent({
    actor: "core",
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    ...input,
    id,
    item_id: input.item_id ?? parent.item_id ?? null,
    parent_event_id: parent.id,
    root_event_id: parent.root_event_id ?? parent.id,
    depth: (parent.depth ?? 0) + 1,
  });
  return event;
}

export function eventName(event) {
  return `${event.entity}.${event.lifecycle}`;
}

// --- DB row mapping --------------------------------------------------------

export function eventToRow(event) {
  return {
    id: event.id,
    actor: event.actor,
    occurred_at: event.occurred_at,
    created_at: event.created_at,
    entity: event.entity,
    lifecycle: event.lifecycle,
    envelope_json: event.envelope ? JSON.stringify(event.envelope) : null,
    attention_json: event.attention ? JSON.stringify(event.attention) : null,
    payload_json: JSON.stringify(event.payload),
    item_id: event.item_id ?? null,
    plugin_id: event.plugin_id ?? null,
    parent_event_id: event.parent_event_id ?? null,
    root_event_id: event.root_event_id ?? null,
    depth: event.depth ?? 0,
    schema_version: event.schema_version ?? 1,
    dedup_key: event.dedup_key ?? null,
  };
}

export function rowToEvent(row) {
  return {
    id: row.id,
    actor: row.actor,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    entity: row.entity,
    lifecycle: row.lifecycle,
    envelope: row.envelope_json ? JSON.parse(row.envelope_json) : null,
    attention: row.attention_json ? JSON.parse(row.attention_json) : null,
    payload: JSON.parse(row.payload_json),
    item_id: row.item_id ?? null,
    plugin_id: row.plugin_id ?? null,
    parent_event_id: row.parent_event_id ?? null,
    root_event_id: row.root_event_id ?? null,
    depth: row.depth ?? 0,
    schema_version: row.schema_version ?? 1,
    dedup_key: row.dedup_key ?? null,
  };
}
