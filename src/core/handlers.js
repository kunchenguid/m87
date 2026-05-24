import { childEvent, eventName } from "./event.js";
import { project } from "./projections.js";

// Core-owned handler chains, keyed by event type (plan §4). A chain is an
// ordered, deliberately-sequenced list of core handlers - this is fine BECAUSE
// core owns every link (cf. plan §9: user extension would be unordered
// subscribers, not chains). Handlers run INSIDE the commit-as-ack transaction.
//
// A handler receives a ctx with:
//   ctx.db      - the (transaction-bound) database
//   ctx.event   - the event being processed
//   ctx.emit(input, {lane, availableAt})  - enqueue a child event (next turn)
//   ctx.effect(spec)                      - request an async side-effect (edges)
//
// Handlers never perform external I/O. Persistence is `project`; follow-on work
// is emitted events; slow work (plugin/agent) is an effect launched after commit.

// async effect kinds: sync (plugin diff), triage (agent), action (plugin
// execute), fix (automation job). 'job' entity rows back fix only.

const projectHandler = (ctx) => project(ctx.db, ctx.event);

function attentionPolicy(ctx) {
  const item = ctx.db
    .prepare("select * from items where id = ?")
    .get(ctx.event.item_id);
  if (!item) {
    return;
  }
  const shouldSurface = ctx.event.attention?.should_surface !== false;
  if (item.local_state === "new" && shouldSurface) {
    ctx.effect({
      type: "triage",
      item_id: item.id,
      // a `rerun --instructions` rides in on the item.updated payload; forward
      // it so the daemon's auto-triage uses it.
      rerun_instructions: ctx.event.payload?.rerun_instructions ?? null,
    });
  }
}

function scheduleSnooze(ctx) {
  const p = ctx.event.payload ?? {};
  if (p.type !== "snoozed" || !p.snoozed_until) {
    return;
  }
  // re-surface the item when the snooze elapses: a future item.updated that
  // resets local_state to 'new'. Background lane; deduped by a stable key.
  ctx.emit(
    {
      actor: "core",
      entity: "item",
      lifecycle: "updated",
      item_id: ctx.event.item_id,
      payload: {
        type: "snooze_expired",
        local_state: "new",
        clear_snooze: true,
      },
      dedup_key: `snooze-expired:${ctx.event.item_id}:${p.snoozed_until}`,
    },
    { lane: "background", availableAt: p.snoozed_until },
  );
}

function gateCheck(ctx) {
  // Invariant V: the human gate. Validate the approval references a real option.
  const p = ctx.event.payload ?? {};
  const option = ctx.db
    .prepare("select * from recommendation_options where id = ?")
    .get(p.option_id);
  if (!option) {
    throw new Error(
      `approval ${p.approval_id} references unknown option ${p.option_id}`,
    );
  }
}

function fanOut(ctx) {
  const p = ctx.event.payload ?? {};
  const option = ctx.db
    .prepare("select * from recommendation_options where id = ?")
    .get(p.option_id);
  if (!option) {
    return;
  }
  const plugin_id = pluginForItem(ctx.db, ctx.event.item_id);
  const edited = Array.isArray(p.edited_actions) ? p.edited_actions : null;
  const actions = edited ?? JSON.parse(option.actions_json ?? "[]");
  for (const action of actions) {
    ctx.emit({
      actor: "core",
      entity: "action",
      lifecycle: "created",
      item_id: ctx.event.item_id,
      plugin_id,
      payload: {
        type: "queued",
        action_id: action.id,
        approval_id: p.approval_id,
        action_type: action.action_type,
        required: action.required ?? true,
        depends_on: action.depends_on ?? [],
        safety: action.safety ?? "safe",
        plugin_id,
        request: { action },
      },
    });
  }
  const automation = option.automation_json
    ? JSON.parse(option.automation_json)
    : null;
  if (automation) {
    ctx.emit({
      actor: "core",
      entity: "job",
      lifecycle: "created",
      item_id: ctx.event.item_id,
      plugin_id,
      payload: {
        type: "queued",
        job_id: `job-${p.approval_id}`,
        kind: "fix",
        recommendation_id: p.recommendation_id,
        option_id: p.option_id,
        approval_id: p.approval_id,
        prompt: automation.prompt ?? "",
        metadata: { automation },
      },
    });
  }
}

function dispatchAction(ctx) {
  const p = ctx.event.payload ?? {};
  ctx.effect({
    type: "action",
    item_id: ctx.event.item_id,
    approval_id: p.approval_id,
    action_id: p.action_id,
    action: p.request?.action,
  });
}

function checkComplete(ctx) {
  const p = ctx.event.payload ?? {};
  const approvalId = p.approval_id;
  if (!approvalId) {
    return;
  }
  const results = ctx.db
    .prepare(
      "select required, status from action_results where approval_id = ?",
    )
    .all(approvalId);
  const pending = results.some((r) => r.status === "running");
  if (pending) {
    return; // wait for the rest
  }
  const requiredFailed = results.some(
    (r) =>
      r.required && r.status !== "succeeded" && r.status !== "already_applied",
  );
  // Only settle once: a job (automation) may still be running for this item.
  const job = ctx.db
    .prepare("select status from jobs where approval_id = ?")
    .get(approvalId);
  if (job && job.status !== "succeeded" && job.status !== "failed") {
    return; // automation still in flight; let job.closed settle
  }
  settleItem(ctx, requiredFailed, approvalId);
}

function dispatchJob(ctx) {
  const p = ctx.event.payload ?? {};
  ctx.effect({ type: "fix", job_id: p.job_id, item_id: ctx.event.item_id });
}

function maybeAttach(ctx) {
  // A `job attach` request asks the daemon to re-check for the fix PR (FU-15).
  const p = ctx.event.payload ?? {};
  if (p.type === "attach_requested" && p.job_id) {
    ctx.effect({ type: "fix_detect", job_id: p.job_id });
  }
}

function maybeSettle(ctx) {
  const p = ctx.event.payload ?? {};
  const failed = p.status === "failed";
  // settle only when any sibling actions are also done
  const job = ctx.db
    .prepare("select approval_id from jobs where id = ?")
    .get(p.job_id);
  if (job?.approval_id) {
    const pendingActions = ctx.db
      .prepare(
        "select 1 from action_results where approval_id = ? and status = 'running' limit 1",
      )
      .get(job.approval_id);
    if (pendingActions) {
      return;
    }
  }
  settleItem(ctx, failed, job?.approval_id ?? p.job_id);
}

function settleItem(ctx, failed, key) {
  ctx.emit({
    actor: "core",
    entity: "item",
    lifecycle: "updated",
    item_id: ctx.event.item_id,
    payload: {
      type: failed ? "action_error" : "handled",
      local_state: failed ? "action_error" : "handled",
    },
    // dedupe: action.closed and job.closed can both reach settle for one cycle.
    dedup_key: `settle:${key}:${failed ? "err" : "ok"}`,
  });
}

function pluginForItem(db, itemId) {
  const row = db
    .prepare("select plugin_id from items where id = ?")
    .get(itemId);
  return row?.plugin_id ?? null;
}

// The catalog. Every chain begins with `project` (fold the dequeued event),
// then entity-specific decision handlers.
const registry = {
  "item.created": [projectHandler, attentionPolicy],
  "item.updated": [projectHandler, attentionPolicy, scheduleSnooze],
  "item.closed": [projectHandler],
  "item.deleted": [projectHandler],
  "recommendation.created": [projectHandler],
  "recommendation.closed": [projectHandler],
  "approval.created": [gateCheck, projectHandler, fanOut],
  "action.created": [projectHandler, dispatchAction],
  "action.closed": [projectHandler, checkComplete],
  "job.created": [projectHandler, dispatchJob],
  "job.updated": [projectHandler, maybeAttach],
  "job.closed": [projectHandler, maybeSettle],
};

export function handlersFor(event) {
  return registry[eventName(event)] ?? [projectHandler];
}

/**
 * Run the handler chain for an event. Collects child events and async effects.
 * Pure with respect to the outside world: only DB writes (via project) and
 * in-memory collection. The loop runs this inside the commit txn.
 */
export function runChain(db, event) {
  const children = [];
  const effects = [];
  const ctx = {
    db,
    event,
    emit(input, opts = {}) {
      children.push({ event: childEvent(event, input), ...opts });
    },
    effect(spec) {
      effects.push(spec);
    },
  };
  for (const handler of handlersFor(event)) {
    handler(ctx);
  }
  return { children, effects };
}

export { registry };
