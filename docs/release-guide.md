# FirstPass Release Guide

This guide covers the first release path for installing FirstPass, configuring local state, installing plugins, handling credentials, setting retention policy, choosing ACP targets, and running the first GitHub workflow.
FirstPass is local-first: source data, recommendations, approvals, action receipts, and audit history are stored under the configured state directory unless explicitly exported.

## Install

FirstPass requires Node.js 20 or newer.
The package exposes the `firstpass` binary.

For a published release, install it globally:

```sh
npm install -g firstpass
```

Verify the installed binary:

```sh
firstpass --version
firstpass status
```

For local development before publishing, use the repository scripts instead:

```sh
pnpm install
pnpm run build
node src/cli.js status
```

## Initial Setup

Initialize local configuration and state:

```sh
firstpass init
firstpass status
```

By default, FirstPass reads configuration and stores local state under `~/.firstpass`.
Set `FIRSTPASS_STATE_DIR` to use a different state directory.
The status command reports configured state, agent target and source, installed plugin sync health, local item counts, queue counts, and audit event count.

Example minimal config:

```yaml
agent: null
poll_interval: 300
acp_registry_overrides: {}
plugins: {}
```

The state directory contains the SQLite database, plugin state, ACP session directory, daemon PID file, and retained local artifacts.
Installed plugin configuration is stored with the plugin record.

## Plugin Trust

FirstPass source plugins are local executables.
They are not sandboxed by FirstPass, so only install plugins from publishers and binary paths you trust.

List available plugins:

```sh
firstpass plugin list
firstpass plugin doctor
```

Install a discovered plugin:

```sh
firstpass plugin add <plugin-id>
```

`firstpass plugin doctor` health-checks installed plugins.

## Credentials

Core FirstPass config should not contain source secrets.
Prefer source-owned credential stores such as a source CLI, OAuth token store, OS keychain, or plugin-owned encrypted credential file.

When configuring a source plugin, choose trusted bundled plugins and credential paths:

```sh
firstpass plugin add <plugin-id>
firstpass plugin configure <plugin-id> --config <key>=<value>
```

Use the narrowest credential scope that supports the workflow you need.
If write credentials are optional, start with read-only credentials and enable write scopes only when approval actions require them.

## Retention

Retention settings control how long FirstPass keeps raw source context, rendered context, prompt context, drafts, and attachment metadata.
Audit-preserved approval and action history is retained separately so receipts remain available after context cleanup.

Run retention cleanup before destructive maintenance when needed:

```sh
firstpass retention cleanup
```

Export a portable state snapshot before destructive maintenance or machine migration:

```sh
firstpass state export > firstpass-state.json
firstpass state import firstpass-state.json
```

State export includes installed plugin identities and redacted core configuration, including raw custom ACP command strings.
It does not export plugin configuration or credentials.
Imported bundled plugins are reinstalled with existing local config if present, or empty config otherwise, so credentials must be supplied again when needed.

## ACP Targets

FirstPass can route recommendation generation to an ACP-compatible target when configured.
Hosted model targets should be treated as data-sharing boundaries because prompt context can include source-derived content.

Use `firstpass status` to verify the currently configured ACP target before running triage.
For sensitive sources, use a local ACP target or avoid running triage for plugins whose source content should not enter prompts.

Custom ACP command specs are redacted in status, item detail, and state export output.
Accepted ACP target config values are either `agent: null`, a named registry target such as `agent: acp:mock-agent`, or a raw ACP server command string after `acp:`.
Raw command targets are shown as `acp:custom` in status and audit surfaces.

## First GitHub Workflow

GitHub and mock are the only required MVP source paths.
The bundled Gmail plugin, if present, is fixture-backed or demo-only for this release and should not be used as evidence of production Gmail readiness.

The first GitHub workflow is intentionally approval-first.
FirstPass can sync GitHub items, generate local recommendations, preview actions, and execute only after explicit approval.

1. Ensure GitHub credentials are available through the GitHub plugin's supported credential path.
2. Install the GitHub plugin.
3. Configure the GitHub source.
4. Run a one-shot sync.
5. Review the queue.
6. Triage an item.
7. Inspect the recommendation and evidence.
8. Approve an action only after reviewing the preview.
9. Export the approval receipt for audit.

Commands:

```sh
firstpass plugin add github
firstpass plugin configure github \
  --config username=<github-login> \
  --config explicit_repos=<owner>/<repo>
firstpass sync
firstpass list
firstpass view <item-id>
firstpass triage <item-id>
firstpass view <item-id>
firstpass preview <recommendation-id> --option <option-id>
firstpass approve <recommendation-id> --option <option-id> --confirm
firstpass audit receipt <approval-id>
```

Use `--config owned_repos=true` to sync source repositories for the configured username, or `--config authored_external=true` to sync recently updated issues and PRs authored by that user outside explicitly configured repositories.
GitHub approvals can create real comments, reviews, close/reopen state changes, and other source-visible effects declared by the plugin action catalog.
Review `firstpass preview` output before running `firstpass approve`; destructive actions require the additional `--confirm-destructive` flag.

Use `firstpass open <item-id>` to open the native GitHub URL when you need to compare local context with the source.
Use `firstpass dismiss`, `firstpass snooze`, or `firstpass mark-handled` for local queue state that should not execute a source action.

## Release Validation

Before publishing a release, run the local validation suite:

```sh
pnpm run build
pnpm run lint
pnpm run typecheck
pnpm run format
pnpm test
```

After publishing, verify a fresh global install on each supported Node and OS target:

```sh
npm install -g firstpass
firstpass --version
firstpass init
firstpass status
```
