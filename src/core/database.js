import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

// The event-driven schema. Three kinds of table:
//   1. `events` - the immutable, append-only log. The source of every fact.
//   2. `queue`  - mutable work list of pending/scheduled events (single consumer).
//   3. domain entity projections - materialized current state, folded from events.
//
// Greenfield: there is no migration from the legacy schema. The schema is
// versioned so future event-payload evolution can migrate forward (plan §6),
// but it starts as a single definition.
const SCHEMA_VERSION = 1;

const schema = `
-- 1. THE IMMUTABLE LOG ------------------------------------------------------
-- Append-only. Never UPDATE, never DELETE. item_id / parent_event_id are
-- denormalized indexes into the log, NOT foreign keys: an event is appended
-- before its projection (the item row) exists, so a hard FK would deadlock
-- ordering. The log is primary; projections are derived.
create table events (
  id text primary key,
  actor text not null,                 -- plugin:<id> | core | user | agent
  occurred_at text not null,           -- when the fact happened (source clock)
  created_at text not null,            -- when we appended it (our clock)
  entity text not null,                -- item | recommendation | approval | action | job
  lifecycle text not null,             -- created | updated | closed | deleted
  envelope_json text,                  -- fixed core fields (title,state,url,activity_at,fingerprint)
  attention_json text,                 -- should_surface, reason, waiting_on, priority_hint
  payload_json text not null,          -- OPAQUE inner body: source's own type-name + detail
  item_id text,                        -- which item this fact is about (logical id)
  plugin_id text,                      -- originating plugin, if any
  parent_event_id text,                -- the event that caused this one
  root_event_id text,                  -- the root of the causal tree
  depth integer not null default 0,    -- cascade-budget guard
  schema_version integer not null default ${SCHEMA_VERSION},
  dedup_key text                       -- idempotent ingestion (deterministic per fact)
);
create unique index events_dedup on events(dedup_key) where dedup_key is not null;
create index events_timeline on events(item_id, occurred_at);
create index events_root on events(root_event_id);
create index events_seq on events(created_at, id);

-- 2. THE QUEUE --------------------------------------------------------------
-- Pending + scheduled events. Single consumer => no claim/lease needed.
-- The commit-as-ack invariant (VI) deletes the row in the same txn as the
-- projection. status flips to 'dead_letter' (VII) after max attempts.
create table queue (
  id text primary key,
  event_id text not null references events(id),
  available_at text not null,          -- now, or a future time (snooze / retry backoff)
  lane text not null default 'default', -- interactive | default | background (strict-priority)
  attempts integer not null default 0,
  last_error text,
  status text not null default 'pending', -- pending | dead_letter
  created_at text not null
);
create index queue_due on queue(status, lane, available_at);

-- 3. DOMAIN ENTITY PROJECTIONS ----------------------------------------------
-- Authoritative for CURRENT state; folded from the log. Each carries a
-- source_event_id back-ref to the event that last wrote it.
create table plugins (
  id text primary key,
  binary_path text not null,
  binary_hash text,
  version text not null,
  protocol_version text not null,
  manifest_json text not null,
  config_json text,
  fingerprints_json text,              -- the diff baseline core hands back into sync
  status text,
  last_sync_at text,
  last_error text,
  installed_at text not null,
  last_checked_at text
);

create table items (
  id text primary key,
  plugin_id text not null,
  external_id text not null,
  item_type text not null,
  title text not null,
  actor text not null,
  state text not null,
  url text not null,
  activity_at text not null,
  activity_id text not null,
  content_fingerprint text not null,
  attention_reason text not null,
  attention_priority_hint text,
  waiting_on text not null,
  local_state text not null,           -- projection of item.* events
  snoozed_until text,
  metadata_json text not null,
  source_event_id text,
  created_at text not null,
  updated_at text not null,
  unique (plugin_id, external_id)
);
create index items_local_state on items(local_state);

create table agent_runs (
  id text primary key,
  item_id text not null,
  recommendation_id text,
  source_event_id text,
  agent_spec text not null,
  acp_target_redacted text not null,
  acp_session_key text not null,
  status text not null,
  tokens_in integer not null,
  tokens_out integer not null,
  usage_estimated integer not null,
  error text,
  started_at text,
  completed_at text
);

create table recommendations (
  id text primary key,
  item_id text not null,
  agent_run_id text,
  source_event_id text,
  summary text not null,
  evidence_json text not null,
  activity_at text not null,
  content_fingerprint text not null,
  created_at text not null,
  superseded_at text
);

create table recommendation_options (
  id text primary key,
  recommendation_id text not null,
  position integer not null,
  title text not null,
  rationale text not null,
  evidence_refs_json text not null,
  confidence text not null,
  waiting_on text not null,
  actions_json text not null,
  automation_json text,
  created_at text not null
);

-- write-once authorization record (invariant V). A thin index over the
-- approval.created event; effects reference it. Never updated.
create table approvals (
  id text primary key,
  recommendation_id text not null,
  option_id text not null,
  item_id text not null,
  source_event_id text,
  decision text not null,
  edited_actions_json text not null,
  idempotency_key text not null,
  created_at text not null
);

create table action_results (
  id text primary key,
  approval_id text not null,
  item_id text not null,
  plugin_id text not null,
  action_id text not null,
  action_type text not null,
  required integer not null,
  depends_on_json text not null,
  safety text not null,
  status text not null,
  validation_json text,
  preview_json text,
  request_json text not null,
  result_json text,
  error text,
  source_event_id text,
  started_at text,
  completed_at text
);

create table action_previews (
  id text primary key,
  recommendation_id text not null,
  option_id text not null,
  item_id text not null,
  plugin_id text not null,
  action_id text not null,
  action_type text not null,
  required integer not null,
  depends_on_json text not null,
  safety text not null,
  validation_json text not null,
  preview_json text not null,
  request_json text not null,
  edited_actions_json text not null,
  created_at text not null
);

create table jobs (
  id text primary key,
  item_id text not null,
  recommendation_id text,
  option_id text,
  approval_id text,
  kind text not null,                  -- sync | triage | action | fix
  status text not null,                -- queued | running | succeeded | failed
  phase text not null,
  prompt text not null,
  metadata_json text not null,
  error text,
  source_event_id text,
  created_at text not null,
  started_at text,
  updated_at text not null,
  completed_at text
);
create index jobs_status on jobs(status);

create table prompt_contexts (
  id text primary key,
  item_id text not null,
  recommendation_id text,
  retention_class text not null,
  human_context_json text not null,
  agent_context_json text not null,
  evidence_json text not null,
  redaction_hints_json text not null,
  created_at text not null,
  expires_at text,
  deleted_at text
);

create table retention_policies (
  id text primary key,
  scope text not null,
  raw_context_ttl text not null,
  prompt_ttl text not null,
  draft_ttl text not null,
  attachment_ttl text not null,
  audit_ttl text not null,
  created_at text not null,
  updated_at text not null
);
`;

export function createDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  // The daemon is the sole loop/consumer, but the CLI and TUI are separate
  // processes that append events (writes) and read projections concurrently.
  // busy_timeout makes those cross-process writes wait rather than throw
  // SQLITE_BUSY under WAL.
  database.pragma("busy_timeout = 5000");
  initialize(database);
  return database;
}

function initialize(database) {
  database.exec(`
    create table if not exists schema_meta (
      key text primary key,
      value text not null
    )
  `);
  const row = database
    .prepare("select value from schema_meta where key = 'version'")
    .get();
  if (row) {
    return; // already initialized
  }
  const apply = database.transaction(() => {
    database.exec(schema);
    database
      .prepare("insert into schema_meta (key, value) values ('version', ?)")
      .run(String(SCHEMA_VERSION));
  });
  apply();
}

export { SCHEMA_VERSION };
