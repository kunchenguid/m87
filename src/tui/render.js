import {
  listInbox,
  recommendationDetail,
  runningJobByItem,
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

// The source label for the meta line. Core stays source-agnostic (PRD: it must
// not understand repos/threads/etc.), so the plugin owns this: it stamps a short
// `display_handle` into item metadata (the GitHub plugin uses "owner/repo · PR
// #221", Gmail "sender · subject"). When a plugin omits it we fall back to the
// humanized `item_type` - a core field every plugin sets - so the line is never
// blank.
function displayHandle(row) {
  let metadata = {};
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    metadata = {};
  }
  if (
    typeof metadata.display_handle === "string" &&
    metadata.display_handle.trim()
  ) {
    return metadata.display_handle.trim();
  }
  const type = row.item_type;
  if (!type || type === "item") {
    return null;
  }
  return type.replace(/_/g, " ");
}

// Compact relative age (s/m/h/d/w) from an ISO timestamp. Null when unparseable.
function relativeAge(iso, now = Date.now()) {
  const then = Date.parse(iso ?? "");
  if (!Number.isFinite(then)) {
    return null;
  }
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}

// "waiting_on" is a generic field. The inbox is the user's own queue, so the
// common "waiting on you" is the default and stays silent (repeating it on every
// row is just noise) - we only call out the exceptions, where someone or
// something else holds the next move.
function humanWaiting(waitingOn) {
  switch (waitingOn) {
    case "other":
      return "waiting on others";
    case "source":
      return "waiting on source";
    case "agent":
      return "agent working";
    default:
      return null;
  }
}

// A short, human-readable preview of an action's params for the WILL DO detail -
// the body of a comment/reply, the labels being applied, else the first stringy
// value. Whitespace is collapsed so it wraps cleanly. Source-agnostic: it reads
// whatever the plugin put in params without knowing the action's semantics.
function actionPreview(params) {
  if (!params || typeof params !== "object") {
    return "";
  }
  const clean = (s) => String(s).replace(/\s+/g, " ").trim();
  const direct = params.body ?? params.text ?? params.message ?? params.comment;
  if (typeof direct === "string") {
    return clean(direct);
  }
  if (
    Array.isArray(params.labels) &&
    params.labels.every((l) => typeof l === "string")
  ) {
    return clean(params.labels.join(", "));
  }
  for (const value of Object.values(params)) {
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return clean(value.join(", "));
    }
  }
  return "";
}

// The second row of each inbox item: <handle> · age, plus a waiting phrase only
// for the non-default states. `lead` is the handle + age; `waiting` is the
// exception callout (usually null); `text` is the whole line for the
// plain-string fallback.
function itemMeta(row) {
  const handle = displayHandle(row);
  const age = relativeAge(row.activity_at);
  const waiting = humanWaiting(row.waiting_on);
  const lead = [handle, age].filter(Boolean).join(" · ");
  const text = [lead, waiting].filter(Boolean).join(" · ");
  return { handle, age, waiting, lead, text };
}

// Word-wrap text to a column width, returning the wrapped lines. Whitespace is
// collapsed; a word longer than the width is hard-split. Used to lay out the
// scrollable WILL DO body deterministically (so the view and the app agree on
// how many lines there are, and therefore how far it can scroll).
export function wrapText(text, width) {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  if (width <= 0) return [clean];
  const lines = [];
  let cur = "";
  const pushHardSplit = (word) => {
    let rest = word;
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    cur = rest;
  };
  for (const word of clean.split(" ")) {
    if (word.length > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      pushHardSplit(word);
    } else if (cur === "") {
      cur = word;
    } else if ((cur + " " + word).length <= width) {
      cur += " " + word;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// The user-visible label for an automation block is its agent-chosen `kind`
// (e.g. "code fix", "recheck"). Rows written before kind became required fall
// back to the generic word.
export function automationLabel(automation) {
  const kind =
    typeof automation?.kind === "string" ? automation.kind.trim() : "";
  return kind || "automation";
}

// Flatten the selected option's actions + automation into display lines for the
// WILL DO section: a label line per action/automation, then its wrapped body. A
// flat line list is what makes the section scrollable line-by-line.
export function willDoLines(opt, bodyWidth) {
  const lines = [];
  for (const action of opt?.actions ?? []) {
    lines.push({ kind: "action", text: action.type });
    for (const wl of wrapText(action.preview, bodyWidth)) {
      lines.push({ kind: "body", text: wl });
    }
  }
  if (opt?.automation) {
    lines.push({ kind: "automation", text: automationLabel(opt.automation) });
    for (const wl of wrapText(opt.automation.prompt, bodyWidth)) {
      lines.push({ kind: "body", text: wl });
    }
  }
  if (lines.length === 0) {
    lines.push({
      kind: "empty",
      text: "records your decision; no source actions",
    });
  }
  return lines;
}

// Geometry of the two-pane body, shared by InboxView (to size the panes) and the
// app (to clamp detail scroll). One source of truth so the scroll math matches
// what is actually drawn.
export function mainLayout(width, height, notice = "") {
  const leftWidth = Math.max(28, Math.floor(width * 0.42));
  const rightWidth = width - leftWidth - 1;
  const headerHeight = 3;
  const footerHeight = 3 + (notice ? 1 : 0);
  const bodyHeight = Math.max(6, height - headerHeight - footerHeight);
  return { leftWidth, rightWidth, bodyHeight };
}

// The scrollable WILL DO window. Pure: given the detail pane size, the selected
// option and a scroll offset, it returns the wrapped lines, the viewport height,
// the clamped start and what is clipped above/below. Both the view (to render)
// and the app (to clamp `j`/`k`) call this so they never disagree.
export function willDoWindow({
  detail,
  opt,
  paneWidth,
  paneHeight,
  scroll = 0,
}) {
  const innerWidth = Math.max(0, paneWidth - 4); // borders + paddingX
  const bodyWidth = Math.max(0, innerWidth - 3); // body lines indent by 3
  const lines = willDoLines(opt, bodyWidth);
  const summaryLines = wrapText(detail?.summary ?? "", innerWidth).length;
  const optionsCount = detail?.options?.length ?? 0;
  // Rows above the WILL DO body, inside the borders(2): title(1), any in-flight
  // automation line(1), summary plus its margin(summaryLines+1), the option
  // rows, then the section's marginTop(1) + separator(1) + header(1).
  const jobLine = detail?.runningJob ? 1 : 0;
  const viewport = Math.max(
    1,
    paneHeight - 2 - 1 - jobLine - (summaryLines + 1) - optionsCount - 3,
  );
  const maxScroll = Math.max(0, lines.length - viewport);
  const start = Math.min(Math.max(0, scroll), maxScroll);
  return {
    lines,
    viewport,
    maxScroll,
    start,
    visible: lines.slice(start, start + viewport),
    moreAbove: start > 0,
    moreBelow: start + viewport < lines.length,
  };
}

// Build the structured view model. Pure read over the projections: no IO beyond
// the queries, safe to call on every keypress/poll tick.
export function buildInboxModel(
  db,
  {
    selectedIndex = 0,
    selectedOption = 0,
    detailScroll = 0,
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

  // Open automation per item: a re-triaged item visibly carries its running
  // fix (row badge + detail line) instead of looking untouched.
  const runningJobs = runningJobByItem(db);

  const items = inbox.map((row, index) => {
    const detail = recommendationDetail(db, row.recommendation_id);
    const options = detail?.options ?? [];
    return {
      index,
      itemId: row.item_id,
      title: row.title,
      state: row.local_state,
      urgent: row.attention_priority_hint === "urgent",
      badges: [
        ...itemBadges(row),
        ...(runningJobs.has(row.item_id) ? ["fix"] : []),
      ],
      meta: itemMeta(row),
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
      // Clamp the option cursor to the live option set; the default (0) is the
      // agent's recommended option, so the common case lands there.
      const optedIndex =
        d.options.length === 0
          ? 0
          : Math.min(Math.max(selectedOption, 0), d.options.length - 1);
      detail = {
        summary: d.recommendation.summary ?? "",
        recommendationId: selectedRow.recommendation_id,
        // The selected item's open automation, shown as an in-flight line so
        // the user sees a fix is already running before re-approving work.
        runningJob: runningJobs.get(selectedRow.item_id) ?? null,
        options: d.options.map((opt, index) => ({
          index,
          number: index + 1,
          title: opt.title,
          confidence: opt.confidence,
          actionCount: opt.actions.length,
          automationLabel: opt.automation
            ? automationLabel(opt.automation)
            : null,
          selected: index === optedIndex,
          // What this option will actually do, for the WILL DO detail section.
          actions: opt.actions.map((a) => ({
            type: (a.action_type ?? "action").replace(/_/g, " "),
            preview: actionPreview(a.params),
          })),
          automation: opt.automation
            ? {
                kind: opt.automation.kind ?? null,
                prompt: opt.automation.prompt ?? "",
              }
            : null,
        })),
      };
    }
  }

  const status = statusSummary(db);
  return {
    count: inbox.length,
    selectedIndex: clampedIndex,
    detailScroll,
    items,
    detail,
    daemonRunning,
    notice,
    status: {
      agentTarget,
      events: status.events,
      pending: status.pending,
      deadLetter: status.dead_letter,
      activity: status.activity,
    },
  };
}

// The header's running-work cluster, e.g. "⚙ 1 triage · 1 fix · 1 awaiting PR".
// Empty string when nothing is running, so the idle header stays clean. Shared
// by the Ink header and the plain-string fallback.
export function activityLabel(activity) {
  if (!activity) {
    return "";
  }
  const parts = [
    [activity.triage, "triage"],
    [activity.fix, "fix"],
    [activity.awaiting_pr, "awaiting PR"],
    [activity.action, "action"],
  ]
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  return parts.length > 0 ? `⚙ ${parts.join(" · ")}` : "";
}

// Plain-string fallback used for non-TTY output and tests. It uses the same
// model as the rich view, but stays a static summary instead of documenting or
// drawing interactive-only affordances like WILL DO scrolling.
export function renderInboxView(db, opts = {}) {
  const model = buildInboxModel(db, opts);
  const lines = [];
  lines.push(
    `M87 Inbox  (${model.count} ${model.count === 1 ? "item" : "items"})`,
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
      const meta = row.meta?.text ? `  ${row.meta.text}` : "";
      lines.push(
        `${marker} [${row.index}] ${row.itemId}  ${row.title}${urgent}${badges}${meta}  (${row.state})`,
      );
    });
  }
  lines.push(RULE);

  if (model.detail) {
    lines.push(`Detail: ${model.detail.summary}`);
    model.detail.options.forEach((opt) => {
      const tags = [];
      if (opt.actionCount) tags.push(`${opt.actionCount} action(s)`);
      if (opt.automationLabel) tags.push(opt.automationLabel);
      lines.push(
        `  (${opt.index}) ${opt.title}  [${opt.confidence}]${tags.length ? "  " + tags.join(", ") : ""}`,
      );
    });
    lines.push(`  rec: ${model.detail.recommendationId}`);
  }
  lines.push(RULE);
  lines.push(
    "Actions: ↑/↓ move · a approve · d dismiss · s snooze · r refresh · q quit",
  );
  lines.push(RULE);

  const running = activityLabel(model.status.activity);
  lines.push(
    `Status: agent=${model.status.agentTarget}  events=${model.status.events}  pending=${model.status.pending}  dead_letter=${model.status.deadLetter}${running ? `  running: ${running}` : ""}`,
  );
  return lines.join("\n");
}
