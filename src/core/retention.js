import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// Retention enforcement for the data classes the PRD names: raw-ish fetched
// source context, rendered context, prompts, drafts, attachments, and audit
// payloads. One global policy row drives everything; per-source TTLs remain
// future work.
//
// Event rows, approvals, and recommendation history are never deleted - they
// are the write-once audit trail the product promises to keep. But purged
// data must not survive inside the log either, so the sweep REDACTS expired
// payload bodies in place (draft action params on superseded
// recommendations, executed request/result bodies past audit_ttl) while
// keeping every row, id, status, timestamp, and causal link. Redacted events
// replay into exactly the compacted projections.

export const RETENTION_FIELDS = [
  "raw_context_ttl",
  "prompt_ttl",
  "draft_ttl",
  "attachment_ttl",
  "audit_ttl",
];

const DEFAULT_POLICY = {
  raw_context_ttl: "7d",
  prompt_ttl: "30d",
  draft_ttl: "30d",
  attachment_ttl: "7d",
  audit_ttl: "365d",
};

// A TTL is a duration ('30d', '12h'), 'keep' (retain forever), or 'never'
// (do not retain: purged at the next sweep).
export function parseTtl(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "keep") return { keep: true };
  if (v === "never") return { never: true };
  const match = /^(\d+)([hd])$/.exec(v);
  if (!match) {
    throw new Error(
      `invalid ttl: ${JSON.stringify(value)} (use a duration like 30d or 12h, or keep, or never)`,
    );
  }
  const n = Number(match[1]);
  return { ms: n * (match[2] === "h" ? 3_600_000 : 86_400_000) };
}

export function seedRetentionPolicy(db) {
  const exists = db
    .prepare("select id from retention_policies where id='retention-default'")
    .get();
  if (exists) return;
  const now = new Date().toISOString();
  db.prepare(
    `insert into retention_policies (id, scope, raw_context_ttl, prompt_ttl, draft_ttl, attachment_ttl, audit_ttl, created_at, updated_at)
     values ('retention-default','global',?,?,?,?,?,?,?)`,
  ).run(
    DEFAULT_POLICY.raw_context_ttl,
    DEFAULT_POLICY.prompt_ttl,
    DEFAULT_POLICY.draft_ttl,
    DEFAULT_POLICY.attachment_ttl,
    DEFAULT_POLICY.audit_ttl,
    now,
    now,
  );
}

export function loadRetentionPolicy(db) {
  return (
    db
      .prepare("select * from retention_policies where id='retention-default'")
      .get() ?? null
  );
}

// created_at at or before the cutoff is past its TTL. null means keep forever.
function cutoffFor(ttlValue, now) {
  const ttl = parseTtl(ttlValue);
  if (ttl.keep) return null;
  if (ttl.never) return now.toISOString();
  return new Date(now.getTime() - ttl.ms).toISOString();
}

/**
 * Whether (and until when) a freshly fetched prompt context may be stored,
 * under the current policy's prompt_ttl. 'never' means do not store at all.
 */
export function promptContextRetention(db, now = new Date()) {
  const policy = loadRetentionPolicy(db) ?? DEFAULT_POLICY;
  const ttl = parseTtl(policy.prompt_ttl);
  if (ttl.never) return { store: false, expires_at: null };
  if (ttl.keep) return { store: true, expires_at: null };
  return {
    store: true,
    expires_at: new Date(now.getTime() + ttl.ms).toISOString(),
  };
}

/**
 * Apply the retention policy: purge raw agent context, expired prompt
 * contexts, inactive drafts, old attachment files, and old audit payloads.
 * Returns per-class purge counts.
 */
export function sweepRetention(db, { stateDir = null, now = new Date() } = {}) {
  const policy = loadRetentionPolicy(db) ?? DEFAULT_POLICY;
  const nowIso = now.toISOString();
  const counts = {
    raw_contexts: 0,
    prompt_contexts: 0,
    drafts: 0,
    draft_options: 0,
    attachments: 0,
    audit_payloads: 0,
    audit_events: 0,
  };

  const applyDatabaseRetention = db.transaction(() => {
    // Raw-ish fetched source context: the agent_context column is the closest
    // thing to raw source content we hold, so it goes first; the rendered
    // human context and evidence catalog survive until prompt_ttl.
    const rawCutoff = cutoffFor(policy.raw_context_ttl, now);
    if (rawCutoff) {
      counts.raw_contexts = db
        .prepare(
          `update prompt_contexts set agent_context_json='null'
            where deleted_at is null
              and agent_context_json != 'null'
              and created_at <= ?`,
        )
        .run(rawCutoff).changes;
    }

    // Prompt contexts: a per-row expires_at (stamped at write time) is always
    // honored, even if the policy was later relaxed - the row was stored under
    // the stricter promise. The purge blanks content; the row stays as a
    // tombstone so history still shows a context existed.
    const promptCutoff = cutoffFor(policy.prompt_ttl, now);
    const expiry = promptCutoff
      ? "((expires_at is not null and expires_at <= ?) or created_at <= ?)"
      : "(expires_at is not null and expires_at <= ?)";
    counts.prompt_contexts = db
      .prepare(
        `update prompt_contexts
            set deleted_at=?, human_context_json='null', agent_context_json='null',
                evidence_json='null', redaction_hints_json='null'
          where deleted_at is null and ${expiry}`,
      )
      .run(
        ...(promptCutoff ? [nowIso, nowIso, promptCutoff] : [nowIso, nowIso]),
      ).changes;

    // Drafts: unapproved outgoing payloads on recommendations that are no
    // longer active - action previews, the proposed action params and
    // automation prompts on recommendation options, and the same bodies inside
    // the recommendation.created event. Titles, rationale, and evidence refs
    // stay: they are recommendation history, not drafts. The approved payload
    // survives in approvals, which the PRD keeps as audit.
    const draftCutoff = cutoffFor(policy.draft_ttl, now);
    if (draftCutoff) {
      counts.drafts = db
        .prepare(
          `delete from action_previews
            where created_at <= ?
              and not exists (select 1 from recommendations r
                               where r.id = action_previews.recommendation_id
                                 and (r.superseded_at is null or r.superseded_at > ?))`,
        )
        .run(draftCutoff, draftCutoff).changes;
      counts.draft_options = db
        .prepare(
          `update recommendation_options
              set actions_json='[]', automation_json=null
            where (actions_json != '[]' or automation_json is not null)
              and created_at <= ?
              and recommendation_id in (select id from recommendations
                                         where superseded_at is not null
                                           and superseded_at <= ?)`,
        )
        .run(draftCutoff, draftCutoff).changes;
      redactDraftEvents(db, draftCutoff);
    }

    // Audit payload compaction: keep who/what/when (ids, status, timestamps,
    // errors) forever, drop the bulky request/result payloads after audit_ttl -
    // both in the action_results projection and in the action events that
    // would replay into it.
    const auditCutoff = cutoffFor(policy.audit_ttl, now);
    if (auditCutoff) {
      counts.audit_payloads = db
        .prepare(
          `update action_results
              set validation_json=null, preview_json=null, result_json=null,
                  request_json='{}'
            where completed_at is not null
              and completed_at <= ?
              and (request_json != '{}' or validation_json is not null
                   or preview_json is not null or result_json is not null)`,
        )
        .run(auditCutoff).changes;
      counts.audit_events = redactAuditEvents(db, auditCutoff);
    }
  });

  applyDatabaseRetention();

  // Attachments: the core never copies attachment blobs into the database;
  // anything cached under <stateDir>/attachments is subject to this TTL.
  const attachmentCutoff = cutoffFor(policy.attachment_ttl, now);
  if (attachmentCutoff && stateDir) {
    counts.attachments = sweepDirectory(
      join(stateDir, "attachments"),
      Date.parse(attachmentCutoff),
    );
  }

  return counts;
}

// Strip executed request/result bodies from old action events, keeping only
// the skeleton fields the projection replays (ids, type, status, error,
// safety, ordering). Allow-listing what survives - rather than deleting known
// heavy keys - means future payload fields default to purged.
function redactAuditEvents(db, cutoff) {
  const rows = db
    .prepare(
      `select e.id, e.payload_json from events e
         join action_results ar
           on ar.id = coalesce(
             json_extract(e.payload_json, '$.action_result_id'),
             json_extract(e.payload_json, '$.approval_id') || ':' || json_extract(e.payload_json, '$.action_id')
           )
        where e.entity='action'
          and ar.completed_at is not null
          and ar.completed_at <= ?
          and not exists (select 1 from queue q
                           where q.event_id = e.id and q.status = 'pending')`,
    )
    .all(cutoff);
  const update = db.prepare("update events set payload_json=? where id=?");
  let redacted = 0;
  for (const row of rows) {
    const p = safeParse(row.payload_json);
    if (!p || p.redacted) continue;
    const skeleton = { redacted: true };
    for (const key of [
      "type",
      "action_result_id",
      "action_id",
      "approval_id",
      "action_type",
      "required",
      "depends_on",
      "safety",
      "plugin_id",
      "status",
      "error",
    ]) {
      if (p[key] !== undefined) skeleton[key] = p[key];
    }
    update.run(JSON.stringify(skeleton), row.id);
    redacted += 1;
  }
  return redacted;
}

// Strip draft action params and automation prompts from the events of
// long-superseded recommendations, so the purge of recommendation_options
// cannot be undone by a replay. Summary, evidence, titles, and rationale
// stay - they are recommendation history.
function redactDraftEvents(db, cutoff) {
  const rows = db
    .prepare(
      `select e.id, e.payload_json from events e
        where e.entity='recommendation' and e.lifecycle='created'
          and e.created_at <= ?
          and exists (select 1 from recommendations r
                       where r.id = json_extract(e.payload_json, '$.recommendation_id')
                         and r.superseded_at is not null
                         and r.superseded_at <= ?)`,
    )
    .all(cutoff, cutoff);
  const update = db.prepare("update events set payload_json=? where id=?");
  for (const row of rows) {
    const p = safeParse(row.payload_json);
    if (!p || p.drafts_redacted) continue;
    p.options = (p.options ?? []).map((o) => ({
      ...o,
      actions: [],
      automation: null,
    }));
    p.drafts_redacted = true;
    update.run(JSON.stringify(p), row.id);
  }
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function sweepDirectory(dir, cutoffMs) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // no local attachment cache
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        removed += sweepDirectory(path, cutoffMs);
        rmdirSync(path); // only succeeds once empty
      } else if (statSync(path).mtimeMs <= cutoffMs) {
        rmSync(path);
        removed += 1;
      }
    } catch {
      // raced, still-populated directory, or unreadable entry - skip
    }
  }
  return removed;
}
