import { eventName } from "./event.js";

// Projections fold events into materialized domain entities. They are PURE with
// respect to the outside world (DB writes only, never plugin/agent/network
// effects) and IDEMPOTENT, so re-folding the same event is safe. This is the
// replay-safe half of invariant VI: fold(events) -> state can run any number of
// times; only `process(new event)` (the loop) ever causes external effects.
//
// Each event type has a documented payload contract; the reducer reads those
// fields. The opaque source detail also lives in payload but core ignores it.

export function itemId(pluginId, externalId) {
  return `${pluginId}:${externalId}`;
}

const reducers = {
  // item.created  payload: { type, external_id, item_type, actor, metadata?, local_state? }
  //               envelope: { title, state, url, activity_at, activity_id, fingerprint }
  //               attention: { reason, waiting_on, priority_hint, should_surface }
  "item.created": (db, e) => upsertItem(db, e, { defaultLocalState: "new" }),
  // item.updated  envelope/attention partial; payload.local_state / snoozed_until / clear_snooze
  "item.updated": (db, e) => upsertItem(db, e, { update: true }),
  // item.closed   envelope.state='closed'; payload.local_state (default 'handled')
  "item.closed": (db, e) =>
    upsertItem(db, e, { update: true, defaultLocalState: "handled" }),
  "item.deleted": (db, e) =>
    upsertItem(db, e, { update: true, defaultLocalState: "ignored" }),

  // recommendation.created payload: { recommendation_id, summary, evidence,
  //   options:[{title,rationale,evidence_refs,confidence,waiting_on,actions,automation}],
  //   agent_run_id?, content_fingerprint?, activity_at? }
  "recommendation.created": (db, e) => insertRecommendation(db, e),
  // recommendation.closed payload: { recommendation_id, type:'superseded'|'invalid' }
  "recommendation.closed": (db, e) => closeRecommendation(db, e),

  // approval.created (write-once) payload: { approval_id, recommendation_id,
  //   option_id, decision, edited_actions?, idempotency_key }
  "approval.created": (db, e) => insertApproval(db, e),

  // action.created payload: { action_id, approval_id, action_type, required,
  //   depends_on?, safety, request, plugin_id }
  "action.created": (db, e) => upsertActionResult(db, e, { created: true }),
  // action.closed payload: { action_id, approval_id, status, result?, error? }
  "action.closed": (db, e) => upsertActionResult(db, e, { closed: true }),

  // job.created payload: { job_id, kind, recommendation_id?, option_id?, approval_id?, prompt?, metadata? }
  "job.created": (db, e) => upsertJob(db, e, { created: true }),
  // job.updated payload: { job_id, phase?, status?, metadata? }
  "job.updated": (db, e) => upsertJob(db, e, {}),
  // job.closed payload: { job_id, status:'succeeded'|'failed', phase?, error?, metadata? }
  "job.closed": (db, e) => upsertJob(db, e, { closed: true }),
};

/** Fold a single event into the projections. Idempotent. */
export function project(db, event) {
  const reducer = reducers[eventName(event)];
  if (reducer) {
    reducer(db, event);
  }
}

/** Re-fold a sequence of events (replay/rebuild). Never fires external effects. */
export function replayFold(db, events) {
  for (const event of events) {
    project(db, event);
  }
}

// --- item ------------------------------------------------------------------

function upsertItem(
  db,
  e,
  { defaultLocalState = undefined, update = false } = {},
) {
  const id = e.item_id;
  if (!id) {
    return;
  }
  const env = e.envelope ?? {};
  const att = e.attention ?? {};
  const p = e.payload ?? {};
  const now = e.occurred_at ?? new Date().toISOString();
  const existing = db.prepare("select * from items where id = ?").get(id);

  if (!existing) {
    db.prepare(
      `insert into items
        (id, plugin_id, external_id, item_type, title, actor, state, url,
         activity_at, activity_id, content_fingerprint, attention_reason,
         attention_priority_hint, waiting_on, local_state, snoozed_until,
         metadata_json, source_event_id, created_at, updated_at)
       values
        (@id,@plugin_id,@external_id,@item_type,@title,@actor,@state,@url,
         @activity_at,@activity_id,@content_fingerprint,@attention_reason,
         @attention_priority_hint,@waiting_on,@local_state,@snoozed_until,
         @metadata_json,@source_event_id,@created_at,@updated_at)`,
    ).run({
      id,
      plugin_id: e.plugin_id ?? p.plugin_id ?? "",
      external_id: p.external_id ?? id,
      item_type: p.item_type ?? "item",
      title: env.title ?? p.title ?? "",
      actor: p.actor ?? e.actor ?? "",
      state: env.state ?? "open",
      url: env.url ?? "",
      activity_at: env.activity_at ?? now,
      activity_id: env.activity_id ?? e.id,
      content_fingerprint: env.fingerprint ?? "",
      attention_reason: att.reason ?? "",
      attention_priority_hint: att.priority_hint ?? null,
      waiting_on: att.waiting_on ?? "none",
      local_state: p.local_state ?? defaultLocalState ?? "new",
      snoozed_until: p.snoozed_until ?? null,
      metadata_json: JSON.stringify(p.metadata ?? {}),
      source_event_id: e.id,
      created_at: now,
      updated_at: now,
    });
    return;
  }

  // Update only fields present on the event; preserve the rest.
  const next = {
    title: env.title ?? existing.title,
    state: env.state ?? existing.state,
    url: env.url ?? existing.url,
    activity_at: env.activity_at ?? existing.activity_at,
    activity_id: env.activity_id ?? existing.activity_id,
    content_fingerprint: env.fingerprint ?? existing.content_fingerprint,
    attention_reason: att.reason ?? existing.attention_reason,
    attention_priority_hint:
      att.priority_hint ?? existing.attention_priority_hint,
    waiting_on: att.waiting_on ?? existing.waiting_on,
    local_state:
      p.local_state ?? (update ? existing.local_state : defaultLocalState),
    snoozed_until: p.clear_snooze
      ? null
      : (p.snoozed_until ?? existing.snoozed_until),
    metadata_json: p.metadata
      ? JSON.stringify(p.metadata)
      : existing.metadata_json,
    source_event_id: e.id,
    updated_at: now,
    id,
  };
  db.prepare(
    `update items set title=@title, state=@state, url=@url, activity_at=@activity_at,
       activity_id=@activity_id, content_fingerprint=@content_fingerprint,
       attention_reason=@attention_reason, attention_priority_hint=@attention_priority_hint,
       waiting_on=@waiting_on, local_state=@local_state, snoozed_until=@snoozed_until,
       metadata_json=@metadata_json, source_event_id=@source_event_id, updated_at=@updated_at
     where id=@id`,
  ).run(next);
}

// --- recommendation --------------------------------------------------------

function insertRecommendation(db, e) {
  const p = e.payload ?? {};
  const recId = p.recommendation_id;
  if (!recId) {
    return;
  }
  const now = e.occurred_at ?? new Date().toISOString();
  const exists = db
    .prepare("select id from recommendations where id = ?")
    .get(recId);
  if (!exists) {
    db.prepare(
      `insert into recommendations
        (id, item_id, agent_run_id, source_event_id, summary, evidence_json,
         activity_at, content_fingerprint, created_at, superseded_at)
       values (?,?,?,?,?,?,?,?,?,null)`,
    ).run(
      recId,
      e.item_id,
      p.agent_run_id ?? null,
      e.id,
      p.summary ?? "",
      JSON.stringify(p.evidence ?? []),
      p.activity_at ?? now,
      p.content_fingerprint ?? "",
      now,
    );
    const options = p.options ?? [];
    options.forEach((opt, i) => {
      db.prepare(
        `insert into recommendation_options
          (id, recommendation_id, position, title, rationale, evidence_refs_json,
           confidence, waiting_on, actions_json, automation_json, created_at)
         values (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        opt.id ?? `${recId}-opt-${i}`,
        recId,
        i,
        opt.title ?? "",
        opt.rationale ?? "",
        JSON.stringify(opt.evidence_refs ?? []),
        opt.confidence ?? "medium",
        opt.waiting_on ?? "none",
        JSON.stringify(opt.actions ?? []),
        opt.automation ? JSON.stringify(opt.automation) : null,
        now,
      );
    });
  }
  // mark the item as having a live recommendation
  db.prepare(
    "update items set local_state='recommended', source_event_id=?, updated_at=? where id=? and local_state in ('new','triaging','snoozed','action_error')",
  ).run(e.id, now, e.item_id);
}

function closeRecommendation(db, e) {
  const p = e.payload ?? {};
  const now = e.occurred_at ?? new Date().toISOString();
  if (!p.recommendation_id) {
    return;
  }
  db.prepare(
    "update recommendations set superseded_at=coalesce(superseded_at, ?) where id=?",
  ).run(now, p.recommendation_id);
}

// --- approval (write-once) -------------------------------------------------

function insertApproval(db, e) {
  const p = e.payload ?? {};
  const id = p.approval_id;
  if (!id) {
    return;
  }
  const now = e.occurred_at ?? new Date().toISOString();
  db.prepare(
    `insert or ignore into approvals
      (id, recommendation_id, option_id, item_id, source_event_id, decision,
       edited_actions_json, idempotency_key, created_at)
     values (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    p.recommendation_id,
    p.option_id,
    e.item_id,
    e.id,
    p.decision ?? "approved",
    JSON.stringify(p.edited_actions ?? []),
    p.idempotency_key ?? id,
    now,
  );
  db.prepare(
    "update items set local_state='approved_pending', source_event_id=?, updated_at=? where id=?",
  ).run(e.id, now, e.item_id);
  db.prepare(
    "update recommendations set superseded_at=coalesce(superseded_at, ?) where id=?",
  ).run(now, p.recommendation_id);
}

// --- action ----------------------------------------------------------------

function upsertActionResult(db, e, { created = false, closed = false }) {
  const p = e.payload ?? {};
  const id = p.action_result_id ?? `${p.approval_id}:${p.action_id}`;
  const now = e.occurred_at ?? new Date().toISOString();
  const existing = db
    .prepare("select id from action_results where id = ?")
    .get(id);
  if (created && !existing) {
    db.prepare(
      `insert into action_results
        (id, approval_id, item_id, plugin_id, action_id, action_type, required,
         depends_on_json, safety, status, validation_json, preview_json,
         request_json, source_event_id, started_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      p.approval_id,
      e.item_id,
      p.plugin_id ?? e.plugin_id ?? "",
      p.action_id,
      p.action_type ?? "",
      p.required ? 1 : 0,
      JSON.stringify(p.depends_on ?? []),
      p.safety ?? "safe",
      "running",
      p.validation ? JSON.stringify(p.validation) : null,
      p.preview ? JSON.stringify(p.preview) : null,
      JSON.stringify(p.request ?? {}),
      e.id,
      now,
    );
  }
  if (closed && existing) {
    db.prepare(
      `update action_results set status=?, result_json=?, error=?, source_event_id=?, completed_at=?
       where id=?`,
    ).run(
      p.status ?? "succeeded",
      p.result ? JSON.stringify(p.result) : null,
      p.error ?? null,
      e.id,
      now,
      id,
    );
  }
}

// --- job -------------------------------------------------------------------

function upsertJob(db, e, { created = false, closed = false }) {
  const p = e.payload ?? {};
  const id = p.job_id;
  if (!id) {
    return;
  }
  const now = e.occurred_at ?? new Date().toISOString();
  const existing = db.prepare("select * from jobs where id = ?").get(id);
  if (created && !existing) {
    db.prepare(
      `insert into jobs
        (id, item_id, recommendation_id, option_id, approval_id, kind, status,
         phase, prompt, metadata_json, source_event_id, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      e.item_id,
      p.recommendation_id ?? null,
      p.option_id ?? null,
      p.approval_id ?? null,
      p.kind ?? "fix",
      "queued",
      p.phase ?? "pending",
      p.prompt ?? "",
      JSON.stringify(p.metadata ?? {}),
      e.id,
      now,
      now,
    );
    return;
  }
  if (!existing) {
    return;
  }
  const status = closed
    ? (p.status ?? "succeeded")
    : (p.status ?? existing.status);
  db.prepare(
    `update jobs set status=?, phase=?, error=?, metadata_json=?, source_event_id=?,
       updated_at=?, started_at=coalesce(started_at, ?), completed_at=?
     where id=?`,
  ).run(
    status,
    p.phase ?? existing.phase,
    p.error ?? existing.error,
    p.metadata
      ? JSON.stringify({ ...JSON.parse(existing.metadata_json), ...p.metadata })
      : existing.metadata_json,
    e.id,
    now,
    existing.started_at ? null : now,
    closed ? now : existing.completed_at,
    id,
  );
}
