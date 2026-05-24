// The TUI palette uses ONLY the named ANSI colors (never hard-coded hex/RGB) so
// it adapts to whatever colorscheme the user's terminal is themed with - the
// rice blends into their setup instead of imposing our own. ANSI-16 has no
// orange, so warm "low/stale" states fall back to red/yellow.
export const theme = {
  bg: "black", // dark text on colored chips; the "invisible" gutter bar
  fg: "white", // primary text
  muted: "gray", // secondary labels and separators
  dim: "gray", // chrome and the lowest-emphasis text (ANSI has one gray)
  accent: "cyan", // primary chrome
  accentAlt: "magenta", // secondary chrome
  green: "green", // approve / high confidence / live
  yellow: "yellow", // snooze / medium confidence / stale
  red: "red", // dismiss / urgent / offline / low confidence
  selBg: "blue", // selected row background
  panel: "gray", // panel borders
};

// Map a confidence label to a color, defaulting to muted for unknowns.
export function confidenceColor(confidence) {
  switch ((confidence ?? "").toLowerCase()) {
    case "high":
      return theme.green;
    case "medium":
    case "med":
      return theme.yellow;
    case "low":
      return theme.red;
    default:
      return theme.muted;
  }
}
