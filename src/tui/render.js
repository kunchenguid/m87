import {
  listInbox,
  recommendationDetail,
  statusSummary,
} from "../core/views.js";

// The inbox is built once as a structured *model* (pure data) and then rendered
// two ways: a rich full-screen Ink view (components.js, the interactive TTY) and
// the plain-string fallback below (non-TTY pipes, tests). Keeping a single model
// means both surfaces always agree on badges, confidence, counts and status.

const RULE = "-".repeat(60);

// Plugin-supplied item metadata can carry display badges. This is a generic
// affordance: any plugin that stamps `role`/`stale` into item metadata gets the
// badge for free (the GitHub plugin uses it for contributor and stale items).
function itemBadges(row) {
  let metadata = {};
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    metadata = {};
  }
  const badges = [];
  if (metadata.role === "contributor") {
    badges.push("contrib");
  }
  if (metadata.stale === true) {
    badges.push("stale");
  }
  return badges;
}

// Build the structured view model. Pure read over the projections: no IO beyond
// the queries, safe to call on every keypress/poll tick.
export function buildInboxModel(
  db,
  {
    selectedIndex = 0,
    agentTarget = "none",
    daemonRunning = false,
    notice = "",
  } = {},
) {
  const inbox = listInbox(db);
  const clampedIndex =
    inbox.length === 0
      ? 0
      : Math.min(Math.max(selectedIndex, 0), inbox.length - 1);

  const items = inbox.map((row, index) => {
    const detail = recommendationDetail(db, row.recommendation_id);
    const options = detail?.options ?? [];
    return {
      index,
      itemId: row.item_id,
      title: row.title,
      state: row.local_state,
      urgent: row.attention_priority_hint === "urgent",
      badges: itemBadges(row),
      selected: index === clampedIndex,
      recommendationId: row.recommendation_id,
      optionCount: options.length,
      hasAutomation: options.some((o) => o.automation),
      confidence: options[0]?.confidence ?? null,
    };
  });

  const selectedRow = inbox[clampedIndex];
  let detail = null;
  if (selectedRow) {
    const d = recommendationDetail(db, selectedRow.recommendation_id);
    if (d) {
      detail = {
        summary: d.recommendation.summary ?? "",
        recommendationId: selectedRow.recommendation_id,
        options: d.options.map((opt, index) => ({
          index,
          title: opt.title,
          confidence: opt.confidence,
          actionCount: opt.actions.length,
          hasAutomation: Boolean(opt.automation),
        })),
      };
    }
  }

  const status = statusSummary(db);
  return {
    count: inbox.length,
    selectedIndex: clampedIndex,
    items,
    detail,
    daemonRunning,
    notice,
    status: {
      agentTarget,
      events: status.events,
      pending: status.pending,
      deadLetter: status.dead_letter,
    },
  };
}

// Plain-string fallback used for non-TTY output and tests. Mirrors the rich
// view's information, line for line, from the same model.
export function renderInboxView(db, opts = {}) {
  const model = buildInboxModel(db, opts);
  const lines = [];
  lines.push(
    `FirstPass Inbox  (${model.count} ${model.count === 1 ? "item" : "items"})`,
  );
  lines.push(RULE);

  if (model.items.length === 0) {
    lines.push("  (nothing waiting on you)");
  } else {
    model.items.forEach((row) => {
      const marker = row.selected ? ">" : " ";
      const urgent = row.urgent ? " [urgent]" : "";
      const badges = row.badges.length
        ? `  ${row.badges.map((b) => `[${b}]`).join(" ")}`
        : "";
      lines.push(
        `${marker} [${row.index}] ${row.itemId}  ${row.title}${urgent}${badges}  (${row.state})`,
      );
    });
  }
  lines.push(RULE);

  if (model.detail) {
    lines.push(`Detail: ${model.detail.summary}`);
    model.detail.options.forEach((opt) => {
      const tags = [];
      if (opt.actionCount) tags.push(`${opt.actionCount} action(s)`);
      if (opt.hasAutomation) tags.push("automation");
      lines.push(
        `  (${opt.index}) ${opt.title}  [${opt.confidence}]${tags.length ? "  " + tags.join(", ") : ""}`,
      );
    });
    lines.push(`  rec: ${model.detail.recommendationId}`);
  }
  lines.push(RULE);
  lines.push(
    "Actions: ↑/↓ select · a approve · d dismiss · s snooze · r refresh · q quit",
  );
  lines.push(RULE);

  lines.push(
    `Status: agent=${model.status.agentTarget}  events=${model.status.events}  pending=${model.status.pending}  dead_letter=${model.status.deadLetter}`,
  );
  return lines.join("\n");
}
