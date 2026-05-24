import { Box, Text } from "ink";
import React from "react";

import { confidenceColor, theme } from "./theme.js";

const h = React.createElement;

// A filled chip: dark text on a colored background, e.g. badges and the brand.
function Chip({ label, color, fg = theme.bg, bold = true }) {
  return h(Text, { backgroundColor: color, color: fg, bold }, ` ${label} `);
}

// One key hint: a bright key glyph followed by a muted label.
function Key({ keyLabel, label, color }) {
  return h(
    Text,
    null,
    h(Text, { bold: true, color }, keyLabel),
    h(Text, { color: theme.muted }, ` ${label}`),
  );
}

function Header({ model, width }) {
  const { status, count, daemonRunning } = model;
  const live = daemonRunning
    ? h(Text, { color: theme.green }, "● live")
    : h(Text, { color: theme.red, bold: true }, "○ offline");
  return h(
    Box,
    {
      width,
      borderStyle: "round",
      borderColor: theme.accent,
      paddingX: 1,
      flexDirection: "row",
      alignItems: "center",
    },
    h(Chip, { label: "firstpass", color: theme.accent }),
    h(Text, { color: theme.muted }, "  review queue  "),
    h(Box, { flexGrow: 1 }),
    live,
    h(Text, { color: theme.dim }, "   "),
    h(Text, { color: theme.accentAlt }, `◆ ${status.agentTarget}`),
    h(Text, { color: theme.dim }, "   "),
    h(Text, { color: theme.fg, bold: true }, `${count} `),
    h(Text, { color: theme.muted }, count === 1 ? "item" : "items"),
  );
}

function badgeColor(badge) {
  if (badge === "contrib") return theme.accentAlt;
  if (badge === "stale") return theme.yellow;
  return theme.muted;
}

// Truncate-or-pad to exactly n columns. Padding right-aligns whatever follows
// (badges, dot) so each row is exactly `width` wide and can never flex-wrap.
function fit(str, n) {
  if (n <= 0) return "";
  if (str.length <= n) return str.padEnd(n);
  if (n === 1) return "…";
  return str.slice(0, n - 1) + "…";
}

function ItemRow({ row, width }) {
  const bar = row.selected
    ? h(Text, { color: theme.accent }, "▌")
    : h(Text, { color: theme.bg }, " ");
  const titleColor = row.selected ? theme.fg : theme.muted;
  const urgent = row.urgent
    ? h(Text, { color: theme.red, bold: true }, "▲ ")
    : null;
  const badges = row.badges.map((b) =>
    h(
      Text,
      { key: b },
      " ",
      h(
        Text,
        { color: theme.bg, backgroundColor: badgeColor(b), bold: true },
        ` ${b} `,
      ),
    ),
  );
  // Budget the title by hand: the row is a fixed grid of bar + urgent + title +
  // badges + dot. Reserving exact widths and truncating the title ourselves
  // guarantees a single line - Ink's flex would otherwise wrap a badge that no
  // longer fits beside a very long title.
  const dotWidth = row.confidence ? 2 : 0;
  const badgeWidth = row.badges.reduce((n, b) => n + b.length + 3, 0);
  const fixed = 2 + (row.urgent ? 2 : 0) + badgeWidth + dotWidth;
  const titleBudget = Math.max(0, width - fixed);
  return h(
    Box,
    {
      width,
      height: 1,
      backgroundColor: row.selected ? theme.selBg : undefined,
      flexDirection: "row",
    },
    bar,
    h(Text, null, " "),
    urgent,
    h(
      Text,
      { color: titleColor, bold: row.selected },
      fit(row.title, titleBudget),
    ),
    ...badges,
    row.confidence
      ? h(Text, { color: confidenceColor(row.confidence) }, " ●")
      : null,
  );
}

function InboxPane({ model, width, height }) {
  const items = model.items;
  // Window the list so a long inbox scrolls around the selection instead of
  // overflowing the pane. Account for border (2) + title row (1).
  const capacity = Math.max(1, height - 3);
  let start = 0;
  if (items.length > capacity) {
    start = Math.min(
      Math.max(0, model.selectedIndex - Math.floor(capacity / 2)),
      items.length - capacity,
    );
  }
  const visible = items.slice(start, start + capacity);
  const innerWidth = width - 4; // borders + paddingX

  const body =
    items.length === 0
      ? [
          h(
            Text,
            { key: "empty", color: theme.muted, italic: true },
            "  nothing waiting on you",
          ),
        ]
      : visible.map((row) =>
          h(ItemRow, { key: row.itemId, row, width: innerWidth }),
        );

  const moreAbove = start > 0;
  const moreBelow = start + capacity < items.length;

  return h(
    Box,
    {
      width,
      height,
      borderStyle: "round",
      borderColor: theme.panel,
      paddingX: 1,
      flexDirection: "column",
    },
    h(
      Box,
      { flexDirection: "row" },
      h(Text, { color: theme.accent, bold: true }, "INBOX"),
      h(Text, { color: theme.dim }, moreAbove ? "  ↑ more" : ""),
      h(Box, { flexGrow: 1 }),
      h(Text, { color: theme.dim }, moreBelow ? "more ↓" : ""),
    ),
    ...body,
  );
}

function OptionCard({ opt, width }) {
  const actionTag = opt.actionCount
    ? ` ${opt.actionCount} action${opt.actionCount === 1 ? "" : "s"}`
    : "";
  const autoTag = opt.hasAutomation ? "  ⚙ automation" : "";
  // Pad the confidence label to a fixed width so every option's title starts in
  // the same column - the pills read as an aligned meter down the pane.
  const label = (opt.confidence ?? "").padEnd(6);
  // Reserve the radio (4), confidence pill (label + 2 padding + leading space)
  // and the tags, then truncate the title so the card stays on one line.
  const fixed = 4 + label.length + 2 + 1 + actionTag.length + autoTag.length;
  const titleBudget = Math.max(0, width - fixed);
  return h(
    Box,
    { flexDirection: "row", height: 1 },
    h(Text, { color: theme.dim }, "  ○ "),
    h(
      Text,
      {
        color: theme.bg,
        backgroundColor: confidenceColor(opt.confidence),
        bold: true,
      },
      ` ${label} `,
    ),
    h(Text, { color: theme.fg }, ` ${fit(opt.title, titleBudget)}`),
    actionTag ? h(Text, { color: theme.accent }, actionTag) : null,
    autoTag ? h(Text, { color: theme.accentAlt }, autoTag) : null,
  );
}

function DetailPane({ model, width, height }) {
  const innerWidth = width - 4;
  let body;
  if (!model.detail) {
    body = [
      h(
        Text,
        { key: "none", color: theme.muted, italic: true },
        "select an item to see its recommendation",
      ),
    ];
  } else {
    body = [
      h(
        Box,
        { key: "summary", marginBottom: 1, width: innerWidth },
        // The detail pane is tall, so the summary wraps to multiple lines as a
        // proper description rather than truncating.
        h(Text, { color: theme.fg }, model.detail.summary),
      ),
      ...model.detail.options.map((opt) =>
        h(OptionCard, { key: opt.index, opt, width: innerWidth }),
      ),
      h(Box, { key: "spacer", flexGrow: 1 }),
      h(
        Text,
        { key: "rec", color: theme.dim },
        `rec ${model.detail.recommendationId}`,
      ),
    ];
  }
  return h(
    Box,
    {
      width,
      height,
      borderStyle: "round",
      borderColor: theme.panel,
      paddingX: 1,
      flexDirection: "column",
    },
    h(Text, { color: theme.accentAlt, bold: true }, "RECOMMENDATION"),
    ...body,
  );
}

function Footer({ model, width }) {
  const offline = !model.daemonRunning;
  return h(
    Box,
    { width, flexDirection: "column" },
    h(
      Box,
      {
        flexDirection: "row",
        borderStyle: "round",
        borderColor: theme.dim,
        paddingX: 1,
        columnGap: 2,
      },
      h(Key, { keyLabel: "↑↓", label: "move", color: theme.accent }),
      h(Key, { keyLabel: "a", label: "approve", color: theme.green }),
      h(Key, { keyLabel: "d", label: "dismiss", color: theme.red }),
      h(Key, { keyLabel: "s", label: "snooze", color: theme.yellow }),
      h(Key, { keyLabel: "r", label: "refresh", color: theme.accentAlt }),
      h(Box, { flexGrow: 1 }),
      h(Key, { keyLabel: "q", label: "quit", color: theme.muted }),
    ),
    h(
      Box,
      { flexDirection: "row", paddingX: 1 },
      h(Text, { color: theme.dim }, "events "),
      h(Text, { color: theme.fg }, `${model.status.events}`),
      h(Text, { color: theme.dim }, "  ·  pending "),
      h(Text, { color: theme.fg }, `${model.status.pending}`),
      h(Text, { color: theme.dim }, "  ·  dead-letter "),
      h(
        Text,
        { color: model.status.deadLetter > 0 ? theme.red : theme.fg },
        `${model.status.deadLetter}`,
      ),
    ),
    // Warning and notice each get their own line so they never crowd the counts
    // into truncation on narrow terminals.
    offline
      ? h(
          Box,
          { paddingX: 1 },
          h(
            Text,
            { color: theme.red },
            "⚠ daemon offline - start with `firstpass daemon start`",
          ),
        )
      : null,
    model.notice
      ? h(
          Box,
          { paddingX: 1 },
          h(Text, { color: theme.accent }, `▸ ${model.notice}`),
        )
      : null,
  );
}

// The full-screen inbox. Presentational: everything it draws comes from `model`
// and the terminal dimensions, so it renders identically in tests via
// renderToString and live via Ink's reconciler.
export function InboxView({ model, width = 100, height = 30 }) {
  const leftWidth = Math.max(28, Math.floor(width * 0.42));
  const rightWidth = width - leftWidth - 1;
  // Header is 3 rows; footer is the keybar box (3) + counts (1) plus an extra
  // row each for the offline warning and any notice. Give the body the rest so
  // nothing scrolls the alt-screen.
  const headerHeight = 3;
  const footerHeight =
    4 + (model.daemonRunning ? 0 : 1) + (model.notice ? 1 : 0);
  const bodyHeight = Math.max(6, height - headerHeight - footerHeight);
  return h(
    Box,
    { width, height, flexDirection: "column" },
    h(Header, { model, width }),
    h(
      Box,
      { flexDirection: "row", columnGap: 1, height: bodyHeight },
      h(InboxPane, { model, width: leftWidth, height: bodyHeight }),
      h(DetailPane, { model, width: rightWidth, height: bodyHeight }),
    ),
    h(Footer, { model, width }),
  );
}
