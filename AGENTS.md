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

## User-facing copy

All copy a user reads (wizard screens, headings, choices, prompts, notices) must use plain language describing outcomes the user cares about, not implementation jargon.

Write what the user gets, not how it works internally.
For example, prefer "Launch at startup" over "Install managed service", and "Run in the Background" over "Daemon".

Avoid leaking internal terms into user-facing strings: `daemon`, `launchd`/`systemd`/`schtasks`, `sqlite`, `ACP`/`acp:` targets, "provider CLI", "plugin", "bundled source", and similar.
Show friendly names for known tools (e.g. "Claude" rather than `acp:claude`); keep the technical identifier only as an internal id or in a clearly-labeled advanced option.

Internal identifiers, CLI command strings, log lines, and error/debug output aimed at developers are exempt - this rule is about the product surface end users see.
The setup wizard in `src/setup/init-model.js` is the reference example, and `test/setup/init-model.test.js` has a sweep that fails if a wizard screen leaks these terms.
