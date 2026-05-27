import { Box, Text } from "ink";
import React from "react";

import { theme } from "../tui/theme.js";

const h = React.createElement;

function Chip({ label, color, fg = theme.bg }) {
  return h(
    Text,
    { backgroundColor: color, color: fg, bold: true },
    ` ${label} `,
  );
}

function Key({ keyLabel, label, color }) {
  return h(
    Text,
    null,
    h(Text, { bold: true, color }, keyLabel),
    h(Text, { color: theme.muted }, ` ${label}`),
  );
}

function fit(str, n) {
  if (n <= 0) return "";
  if (str.length <= n) return str.padEnd(n);
  if (n === 1) return "…";
  return str.slice(0, n - 1) + "…";
}

function Header({ model, width }) {
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
    h(Text, { color: theme.muted }, `  ${model.title}  `),
    h(Box, { flexGrow: 1 }),
    h(Text, { color: theme.green }, "● local state"),
  );
}

function Rail({ steps, width, height }) {
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
    ...steps.map((step) => {
      const prefix =
        step.status === "done" ? "✓" : step.status === "current" ? "▌" : " ";
      const color =
        step.status === "done"
          ? theme.green
          : step.status === "current"
            ? theme.fg
            : theme.muted;
      return h(
        Text,
        {
          key: step.id,
          color,
          bold: step.status === "current",
          backgroundColor: step.status === "current" ? theme.selBg : undefined,
        },
        `${prefix} ${fit(step.label, Math.max(1, width - 6))}`,
      );
    }),
  );
}

function Choice({ choice, width }) {
  const marker = choice.selected ? "●" : "○";
  const markerColor = choice.selected ? theme.accent : theme.dim;
  return h(
    Box,
    {
      width,
      borderStyle: "round",
      borderColor: choice.selected ? theme.accent : theme.dim,
      paddingX: 1,
      flexDirection: "column",
    },
    h(
      Text,
      {
        color: choice.selected ? theme.fg : theme.muted,
        bold: choice.selected,
      },
      h(Text, { color: markerColor }, `${marker} `),
      fit(choice.label, Math.max(1, width - 8)),
    ),
    choice.detail
      ? h(
          Text,
          { color: theme.dim },
          fit(choice.detail, Math.max(1, width - 4)),
        )
      : null,
  );
}

function Screen({ model, width, height }) {
  const { screen } = model;
  const bodyWidth = Math.max(1, width - 4);
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
    h(Text, { color: theme.accentAlt, bold: true }, screen.heading),
    ...screen.body.map((line, index) =>
      h(
        Text,
        { key: `body-${index}`, color: theme.muted },
        fit(line, bodyWidth),
      ),
    ),
    screen.input
      ? h(
          Box,
          { key: "input", marginTop: 1, flexDirection: "row" },
          h(Text, { color: theme.accent }, `${screen.input.label}: `),
          screen.input.value
            ? h(Text, { color: theme.fg }, screen.input.value)
            : null,
          // Steady block cursor (normal text color) marks this as an editable
          // field awaiting input.
          h(Text, { color: theme.fg }, "█"),
          screen.input.value
            ? null
            : h(Text, { color: theme.dim }, screen.input.placeholder),
        )
      : null,
    ...screen.choices.map((choice) =>
      h(Choice, { key: choice.id, choice, width: bodyWidth }),
    ),
    model.errors.length > 0
      ? h(
          Box,
          { marginTop: 1, flexDirection: "column" },
          ...model.errors.map((error) =>
            h(Text, { key: error, color: theme.red }, `! ${error}`),
          ),
        )
      : null,
  );
}

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
      h(Key, { keyLabel: "enter", label: "choose", color: theme.green }),
      h(Key, { keyLabel: "b", label: "back", color: theme.yellow }),
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

export function InitWizardView({ model, width = 100, height = 30 }) {
  const railWidth = Math.max(18, Math.min(28, Math.floor(width * 0.26)));
  const screenWidth = width - railWidth - 1;
  const headerHeight = 3;
  const footerHeight = 3 + (model.notice ? 1 : 0);
  const bodyHeight = Math.max(8, height - headerHeight - footerHeight);
  return h(
    Box,
    { width, height, flexDirection: "column" },
    h(Header, { model, width }),
    h(
      Box,
      { flexDirection: "row", columnGap: 1, height: bodyHeight },
      h(Rail, { steps: model.steps, width: railWidth, height: bodyHeight }),
      h(Screen, { model, width: screenWidth, height: bodyHeight }),
    ),
    h(Footer, { model, width }),
  );
}
