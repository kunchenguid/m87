import { Box, Text } from "ink";
import React from "react";

import { mainLayout, willDoWindow } from "./render.js";
import { confidenceColor, theme } from "./theme.js";

const h = React.createElement;

// A filled chip: dark text on a colored background, e.g. badges and the brand.
// Never bold: terminals render a bold base ANSI color as its *bright* variant,
// and bright-black reads as gray - so bold + our black `fg` would defeat the
// whole "dark text on a bright chip" look. The background already carries the
// emphasis, so the dark text stays crisp and readable without it.
function Chip({ label, color, fg = theme.bg }) {
  return h(Text, { backgroundColor: color, color: fg }, ` ${label} `);
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

// Truncate to at most n columns (adding an ellipsis), without padding.
function trunc(str, n) {
  if (n <= 0) return "";
  if (str.length <= n) return str;
  if (n === 1) return "…";
  return str.slice(0, n - 1) + "…";
}

// Truncate-or-pad to exactly n columns. Padding fills the row to `width` so the
// selected-row background covers the whole line and content can never flex-wrap.
function fit(str, n) {
  if (n <= 0) return "";
  return trunc(str, n).padEnd(n);
}

// Each inbox item is two lines in a hanging-indent: a dot hangs at the far left
// (col 1) and both the title and a muted meta line (handle · age, plus the rare
// waiting exception) align under it. Urgency is the dot's COLOUR - red when
// urgent, dim otherwise - not its shape. The selection highlight spans the whole
// row, dot included; a neutral dot uses fg on the selected row so it isn't
// low-contrast mud on the coloured background. There is no confidence dot;
// confidence lives in the recommendation pane.
function ItemRow({ row, width }) {
  const selBg = row.selected ? theme.selBg : undefined;
  const markerColor = row.urgent
    ? theme.red
    : row.selected
      ? theme.fg
      : theme.dim;
  const marker = h(Text, { color: markerColor, bold: row.urgent }, "● ");
  const indentWidth = 2;

  // Line 1: the marker, then the title.
  const titleColor = row.selected ? theme.fg : theme.muted;
  const titleBudget = Math.max(0, width - indentWidth);
  const line1 = h(
    Box,
    { width, height: 1, backgroundColor: selBg, flexDirection: "row" },
    marker,
    h(
      Text,
      { color: titleColor, bold: row.selected },
      fit(row.title, titleBudget),
    ),
  );

  // Line 2: a two-column indent aligning the meta under the title, the meta lead
  // (handle · age) and a waiting phrase only for the exceptional states, then any
  // badges flushed right. On the selected row the background is coloured, where
  // gray reads as low-contrast mud - so secondary text switches to a proper
  // foreground, like the title does. We budget by hand and pad to exactly `width`.
  const meta = row.meta ?? {};
  const metaColor = row.selected ? theme.fg : theme.muted;
  const badges = (row.badges ?? []).map((b) =>
    h(
      Text,
      { key: b },
      " ",
      // Not bold: bold + black fg renders as bright-black (gray). See Chip.
      h(Text, { color: theme.bg, backgroundColor: badgeColor(b) }, ` ${b} `),
    ),
  );
  const badgeWidth = (row.badges ?? []).reduce((n, b) => n + b.length + 3, 0);
  const indent = " ".repeat(indentWidth); // aligns the meta under the title
  const textBudget = Math.max(0, width - indent.length - badgeWidth);
  // Handle-first: the lead is the reason this line exists, so it keeps the budget
  // and the (rare) waiting phrase only fills whatever space is left.
  const waitPhrase = meta.waiting ?? "";
  const lead = meta.lead ?? "";
  const sep = lead && waitPhrase ? " · " : "";
  const leadStr = trunc(lead, textBudget);
  const waitStr = trunc(
    sep + waitPhrase,
    Math.max(0, textBudget - leadStr.length),
  );
  const pad = " ".repeat(
    Math.max(0, textBudget - leadStr.length - waitStr.length),
  );
  const line2 = h(
    Box,
    { width, height: 1, backgroundColor: selBg, flexDirection: "row" },
    h(Text, { color: metaColor }, indent),
    h(Text, { color: metaColor }, leadStr),
    h(Text, { color: metaColor }, waitStr),
    pad ? h(Text, null, pad) : null,
    ...badges,
  );

  return h(Box, { flexDirection: "column" }, line1, line2);
}

function InboxPane({ model, width, height }) {
  const items = model.items;
  // Window the list so a long inbox scrolls around the selection instead of
  // overflowing the pane. Account for border (2) + title row (1); each item now
  // occupies two terminal rows (title + meta), so capacity is halved.
  const capacity = Math.max(1, Math.floor((height - 3) / 2));
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
            "nothing waiting on you",
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
  // The selectable prefix is just the number key. Selection is carried by the
  // row highlight (and the emphasised number), so a radio dot would be redundant.
  // Pressing the number selects an option; `a` approves the selected one.
  const prefix = ` ${opt.number ?? opt.index + 1} `;
  // Reserve the prefix, confidence pill (label + 2 padding + leading space) and
  // the tags, then truncate the title so the card stays on one line.
  const fixed =
    prefix.length + label.length + 2 + 1 + actionTag.length + autoTag.length;
  const titleBudget = Math.max(0, width - fixed);
  return h(
    Box,
    {
      flexDirection: "row",
      height: 1,
      backgroundColor: opt.selected ? theme.selBg : undefined,
    },
    h(
      Text,
      { color: opt.selected ? theme.accent : theme.dim, bold: opt.selected },
      prefix,
    ),
    // Not bold: bold + black fg renders as bright-black (gray). See Chip.
    h(
      Text,
      {
        color: theme.bg,
        backgroundColor: confidenceColor(opt.confidence),
      },
      ` ${label} `,
    ),
    h(
      Text,
      { color: theme.fg, bold: opt.selected },
      ` ${fit(opt.title, titleBudget)}`,
    ),
    actionTag ? h(Text, { color: theme.accent }, actionTag) : null,
    autoTag ? h(Text, { color: theme.accentAlt }, autoTag) : null,
  );
}

// One line of the WILL DO body. An action/automation label leads with a coloured
// glyph; body lines (the wrapped action text) are muted and indented under it.
function WillDoLine({ line }) {
  if (line.kind === "body") {
    return h(Text, { color: theme.muted }, `   ${line.text}`);
  }
  if (line.kind === "empty") {
    return h(Text, { color: theme.muted, italic: true }, line.text);
  }
  const glyph = line.kind === "automation" ? "⚙" : "•";
  const glyphColor =
    line.kind === "automation" ? theme.accentAlt : theme.accent;
  return h(
    Box,
    { flexDirection: "row" },
    h(Text, { color: glyphColor }, ` ${glyph} `),
    h(Text, { color: theme.fg }, line.text),
  );
}

// The WILL DO section: the concrete actions (and any automation) the SELECTED
// option will run, so the user knows what `a` commits to before approving. The
// full text is shown, windowed to the space below the options and scrolled with
// j/k (a hint and ↑/↓ markers on the header show when there is more). Replaces
// the old debug rec-id row.
function ActionDetail({ detail, opt, width, height, scroll }) {
  const win = willDoWindow({
    detail,
    opt,
    paneWidth: width,
    paneHeight: height,
    scroll,
  });
  const innerWidth = width - 4;
  const arrow =
    win.moreAbove && win.moreBelow
      ? "↕"
      : win.moreBelow
        ? "↓"
        : win.moreAbove
          ? "↑"
          : "";
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { color: theme.dim }, "─".repeat(Math.max(0, innerWidth))),
    h(
      Box,
      { flexDirection: "row", width: innerWidth },
      h(
        Text,
        { color: theme.muted },
        `WILL DO${opt.number ? ` · option ${opt.number}` : ""}`,
      ),
      h(Box, { flexGrow: 1 }),
      win.maxScroll > 0 ? h(Text, { color: theme.dim }, `${arrow} j/k`) : null,
    ),
    ...win.visible.map((line, i) => h(WillDoLine, { key: `wd-${i}`, line })),
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
      h(ActionDetail, {
        key: "willdo",
        detail: model.detail,
        opt:
          model.detail.options.find((o) => o.selected) ??
          model.detail.options[0] ??
          {},
        width,
        height,
        scroll: model.detailScroll ?? 0,
      }),
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

// The main-screen footer is just the keybar plus any transient action notice.
// Queue counts and the daemon-offline remediation moved to the info screen (i)
// so the working surface stays uncluttered; the header still shows live/offline.
function Footer({ model, width }) {
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
      h(Key, { keyLabel: "1-9", label: "select", color: theme.accentAlt }),
      h(Key, { keyLabel: "a", label: "approve", color: theme.green }),
      h(Key, { keyLabel: "d", label: "dismiss", color: theme.red }),
      h(Key, { keyLabel: "s", label: "snooze", color: theme.yellow }),
      h(Key, { keyLabel: "r", label: "refresh", color: theme.accentAlt }),
      h(Key, { keyLabel: "i", label: "info", color: theme.accent }),
      h(Box, { flexGrow: 1 }),
      h(Key, { keyLabel: "q", label: "quit", color: theme.muted }),
    ),
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
  // Shared with the app's scroll clamp (mainLayout) so the WILL DO viewport math
  // matches what is actually drawn. Header is 3 rows; footer is the keybar box
  // (3) plus one row for any notice; the body gets the rest.
  const { leftWidth, rightWidth, bodyHeight } = mainLayout(
    width,
    height,
    model.notice,
  );
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

// One labelled row in the info screen: a muted left label and a value column
// that starts in a fixed column so the values line up as a little table.
function InfoRow({ label, children = null }) {
  return h(
    Box,
    { flexDirection: "row" },
    h(Text, { color: theme.muted }, `  ${label.padEnd(14)}`),
    children,
  );
}

// The info screen, reached with `i` and dismissed with `i`/esc. It carries the
// chrome that used to crowd the inbox footer - daemon health (with the start
// command when offline), the agent target, and the queue counts - so the inbox
// itself stays focused on what's waiting on you.
export function InfoView({ model, width = 100, height = 30 }) {
  const { status, daemonRunning, count } = model;
  const daemon = daemonRunning
    ? h(Text, { color: theme.green }, "● live")
    : h(Text, { color: theme.red, bold: true }, "○ offline");
  const deadLetterColor = status.deadLetter > 0 ? theme.red : theme.fg;
  return h(
    Box,
    {
      width,
      height,
      borderStyle: "round",
      borderColor: theme.accent,
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
    },
    h(
      Box,
      { marginBottom: 1, flexDirection: "row", alignItems: "center" },
      h(Chip, { label: "firstpass", color: theme.accent }),
      h(Text, { color: theme.muted }, "  info"),
    ),

    h(InfoRow, { label: "daemon" }, daemon),
    daemonRunning
      ? null
      : h(
          InfoRow,
          { label: "" },
          h(Text, { color: theme.dim }, "start with `firstpass daemon start`"),
        ),
    h(
      InfoRow,
      { label: "agent" },
      h(Text, { color: theme.accentAlt }, `◆ ${status.agentTarget}`),
    ),
    h(
      InfoRow,
      { label: "inbox" },
      h(Text, { color: theme.fg }, `${count} `),
      h(Text, { color: theme.muted }, count === 1 ? "item" : "items"),
    ),

    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: theme.accent, bold: true }, "QUEUE"),
    ),
    h(
      InfoRow,
      { label: "events" },
      h(Text, { color: theme.fg }, `${status.events}`),
    ),
    h(
      InfoRow,
      { label: "pending" },
      h(Text, { color: theme.fg }, `${status.pending}`),
    ),
    h(
      InfoRow,
      { label: "dead-letter" },
      h(Text, { color: deadLetterColor }, `${status.deadLetter}`),
    ),

    h(Box, { flexGrow: 1 }),
    h(
      Box,
      { flexDirection: "row", columnGap: 2 },
      h(Key, { keyLabel: "i", label: "back", color: theme.accent }),
      h(Key, { keyLabel: "esc", label: "back", color: theme.muted }),
      h(Key, { keyLabel: "q", label: "quit", color: theme.muted }),
    ),
  );
}
