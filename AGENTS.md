# AGENTS.md

Conventions for agents working in this repository.
See also [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## Terminal UI (TUI)

The TUI must use **only named ANSI colors** (`cyan`, `red`, `green`, `yellow`, `blue`, `magenta`, `white`, `black`, `gray`).
Never hard-code hex or RGB color values.

Named colors resolve against the user's own terminal colorscheme, so the TUI blends into their setup instead of imposing a fixed palette.
Hard-coded hex emits 24-bit truecolor escapes that look the same everywhere and clash with the user's theme.

All colors are defined once in `src/tui/theme.js` and referenced through the `theme` object - add or change colors there, not inline in components.
ANSI-16 has no orange, so map warm "low/stale" states onto `red` or `yellow`.
