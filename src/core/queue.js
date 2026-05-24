import { randomUUID } from "node:crypto";

import { eventToRow, LANES, MAX_DEPTH, rowToEvent } from "./event.js";

// Retry policy (invariant VII). After MAX_ATTEMPTS a poison event is parked in
// the dead-letter terminus so it can never wedge the single-consumer loop.
export const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;

const insertEventStmt = (db) =>
  db.prepare(
    `insert or ignore into events
       (id, actor, occurred_at, created_at, entity, lifecycle, envelope_json,
        attention_json, payload_json, item_id, plugin_id, parent_event_id,
        root_event_id, depth, schema_version, dedup_key)
     values
       (@id, @actor, @occurred_at, @created_at, @entity, @lifecycle, @envelope_json,
        @attention_json, @payload_json, @item_id, @plugin_id, @parent_event_id,
        @root_event_id, @depth, @schema_version, @dedup_key)`,
  );

/**
 * Append an event to the immutable log. Idempotent: a duplicate dedup_key (or
 * id) is ignored. Returns true if newly appended, false if it already existed.
 */
export function appendEvent(db, event) {
  const info = insertEventStmt(db).run(eventToRow(event));
  return info.changes === 1;
}

/**
 * Append an event AND place it on the queue for processing. Idempotent via
 * dedup_key: a duplicate fact is neither re-logged nor re-queued. Events past
 * the cascade-depth budget are dropped (guard for invariant VII).
 *
 * Returns the queue id, or null if skipped (duplicate or over-budget).
 */
export function enqueue(
  db,
  event,
  { lane = "default", availableAt = undefined } = {},
) {
  if ((event.depth ?? 0) > MAX_DEPTH) {
    return null; // cascade-budget guard
  }
  if (!LANES.includes(lane)) {
    throw new Error(`unknown queue lane: ${lane}`);
  }
  const appended = appendEvent(db, event);
  if (!appended) {
    return null; // already ingested
  }
  const queueId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `insert into queue (id, event_id, available_at, lane, attempts, status, created_at)
     values (?, ?, ?, ?, 0, 'pending', ?)`,
  ).run(queueId, event.id, availableAt ?? now, lane, now);
  return queueId;
}

/**
 * The next due event by strict lane priority then availability. Returns
 * { queueRow, event } or null when nothing is currently due.
 */
export function dequeueDue(db, now = new Date().toISOString()) {
  const row = db
    .prepare(
      `select q.*, e.id as e_id from queue q
         join events e on e.id = q.event_id
        where q.status = 'pending' and q.available_at <= ?
        order by case q.lane
                   when 'interactive' then 0
                   when 'default' then 1
                   when 'background' then 2
                   else 3 end,
                 q.available_at, q.created_at
        limit 1`,
    )
    .get(now);
  if (!row) {
    return null;
  }
  const eventRow = db
    .prepare("select * from events where id = ?")
    .get(row.event_id);
  return { queueRow: row, event: rowToEvent(eventRow) };
}

/**
 * The earliest future availability among pending events, for block-when-idle
 * scheduling. Returns an ISO string or null if the queue is empty.
 */
export function nextAvailableAt(db) {
  const row = db
    .prepare(
      "select min(available_at) as next from queue where status = 'pending'",
    )
    .get();
  return row?.next ?? null;
}

export function pendingCount(db) {
  return db
    .prepare("select count(*) c from queue where status = 'pending'")
    .get().c;
}

export function deadLetterCount(db) {
  return db
    .prepare("select count(*) c from queue where status = 'dead_letter'")
    .get().c;
}

/**
 * Commit-as-ack (invariant VI). In ONE transaction:
 *   1. run `work(db)` which applies projection writes and returns child events
 *   2. append + enqueue every child event (to the next turn, tail of queue)
 *   3. delete the processed queue row (the ack)
 *
 * A crash before this transaction commits leaves the queue row in place, so the
 * event is simply reprocessed on restart - made effectively-once by the
 * idempotent fold. Returns the child events that were enqueued.
 */
export function commit(db, queueRow, work) {
  const run = db.transaction(() => {
    const result = work(db) ?? {};
    const children = result.children ?? [];
    for (const child of children) {
      // child events enqueue at the tail => processed on a later turn (fairness)
      enqueue(db, child.event, {
        lane: child.lane ?? "default",
        availableAt: child.availableAt,
      });
    }
    db.prepare("delete from queue where id = ?").run(queueRow.id);
    return children;
  });
  return run();
}

/**
 * Record a failed processing attempt: increment attempts, schedule a backoff,
 * and dead-letter once MAX_ATTEMPTS is reached (invariant VII). Runs in its own
 * transaction, independent of the failed work.
 */
export function recordFailure(db, queueRow, error, now = Date.now()) {
  const attempts = (queueRow.attempts ?? 0) + 1;
  const message = String(error?.stack ?? error?.message ?? error).slice(
    0,
    2000,
  );
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(
      "update queue set attempts = ?, last_error = ?, status = 'dead_letter' where id = ?",
    ).run(attempts, message, queueRow.id);
    return { status: "dead_letter", attempts };
  }
  const backoff = Math.min(
    BACKOFF_BASE_MS * 2 ** (attempts - 1),
    BACKOFF_CAP_MS,
  );
  const availableAt = new Date(now + backoff).toISOString();
  db.prepare(
    "update queue set attempts = ?, last_error = ?, available_at = ? where id = ?",
  ).run(attempts, message, availableAt, queueRow.id);
  return { status: "pending", attempts, availableAt };
}
