// Read-side projections. The UI (CLI list, TUI) is a reader that tails the log
// and projects its own view - it never receives a push (no notifyUI). These
// queries read the materialized entity tables.

export function listInbox(db, now = new Date().toISOString()) {
  // The projection enforces one live recommendation per item; the newest-rec
  // subquery is a defensive dedup so historical state folded before that rule
  // can never render an item once per live rec.
  return db
    .prepare(
      `select r.id as recommendation_id, r.summary, i.id as item_id, i.title, i.url,
              i.item_type, i.activity_at,
              i.local_state, i.attention_priority_hint, i.attention_reason,
              i.waiting_on, i.metadata_json
         from recommendations r join items i on i.id = r.item_id
        where r.superseded_at is null
          and r.id = (select r2.id from recommendations r2
                       where r2.item_id = r.item_id and r2.superseded_at is null
                       order by r2.created_at desc, r2.rowid desc limit 1)
          and (i.local_state in ('recommended','action_error')
               or (i.local_state='snoozed' and i.snoozed_until <= ?))
        order by case i.attention_priority_hint when 'urgent' then 0 else 1 end,
                 i.activity_at desc`,
    )
    .all(now);
}

export function recommendationDetail(db, recommendationId) {
  const rec = db
    .prepare("select * from recommendations where id = ?")
    .get(recommendationId);
  if (!rec) {
    return null;
  }
  const options = db
    .prepare(
      "select * from recommendation_options where recommendation_id = ? order by position",
    )
    .all(recommendationId)
    .map((o) => ({
      ...o,
      actions: JSON.parse(o.actions_json ?? "[]"),
      automation: o.automation_json ? JSON.parse(o.automation_json) : null,
    }));
  return { recommendation: rec, options };
}

// A cheap "log advanced" cursor the UI polls to know when to re-render.
export function logCursor(db) {
  const row = db
    .prepare("select count(*) c, max(created_at) m from events")
    .get();
  return `${row.c}:${row.m ?? ""}`;
}

export function statusSummary(db) {
  const byState = db
    .prepare("select local_state, count(*) c from items group by local_state")
    .all();
  return {
    events: db.prepare("select count(*) c from events").get().c,
    pending: db
      .prepare("select count(*) c from queue where status='pending'")
      .get().c,
    dead_letter: db
      .prepare("select count(*) c from queue where status='dead_letter'")
      .get().c,
    items: Object.fromEntries(byState.map((r) => [r.local_state, r.c])),
  };
}
