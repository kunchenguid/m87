# FirstPass Release Guide

This guide covers the first release path for installing FirstPass, configuring local state, trusting plugins, handling credentials, setting retention policy, choosing ACP targets, and running the first GitHub workflow.
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

By default, FirstPass reads configuration from `~/.firstpass/config.yaml` and stores local state under the configured state directory.
The status command reports configured state, installed plugins, source account health, ACP target disclosure, token usage summaries, and recent action failures.

Example minimal config:

```yaml
agent: null
poll_interval: 300
state_dir: ~/.firstpass
acp_registry_overrides: {}
retention:
  raw_context_ttl: 30d
  prompt_ttl: 30d
  draft_ttl: active
  attachment_ttl: 7d
  audit_ttl: keep
sources: []
```

`state_dir` controls the SQLite database, plugin install directory, ACP session directory, daemon PID file, and retained local artifacts.
The config file itself remains at `~/.firstpass/config.yaml` so FirstPass can find the configured state directory.

## Plugin Trust

FirstPass source plugins are local executables.
They are not sandboxed by FirstPass, so only install plugins from publishers and binary paths you trust.

List available plugins:

```sh
firstpass plugin list
firstpass plugin doctor
```

Install a discovered plugin only after reviewing the trust disclosure:

```sh
firstpass plugin add <plugin-id>
firstpass plugin add <plugin-id> --trust
```

Trust prompts disclose publisher metadata, distribution metadata, requested scopes, action capabilities, and the binary path.
FirstPass records the trusted manifest and reports drift through `firstpass plugin doctor` when publisher, version, scopes, capabilities, action catalog, or binary path metadata changes.

## Credentials

Core FirstPass config should not contain source secrets.
Prefer source-owned credential stores such as a source CLI, OAuth token store, OS keychain, or plugin-owned encrypted credential file.

When adding a source account, follow the plugin disclosure and credential guidance:

```sh
firstpass source add <plugin-id>
firstpass source add <plugin-id> --account <account-name> --trust
```

Use the narrowest credential scope that supports the workflow you need.
If write credentials are optional, start with read-only credentials and enable write scopes only when approval actions require them.

## Retention

Retention settings control how long FirstPass keeps raw source context, rendered context, prompt context, drafts, and attachment metadata.
Audit-preserved approval and action history is retained separately so receipts remain available after context cleanup.

Review retention policy in local status:

```sh
firstpass status
```

Export a portable state snapshot before destructive maintenance or machine migration:

```sh
firstpass state export > firstpass-state.json
firstpass state import firstpass-state.json
```

State export redacts source-account secrets and raw custom ACP command strings.
Imported source accounts are marked for reconfiguration because redacted exports do not contain usable credentials.

## ACP Targets

FirstPass can route recommendation generation to an ACP-compatible target when configured.
Hosted model targets should be treated as data-sharing boundaries because prompt context can include source-derived content.

Use `firstpass status` to verify the currently configured ACP target and hosted-model disclosure before running triage.
For sensitive source accounts, disable agent processing in config so items can sync without prompt-context generation:

```yaml
sources:
  - id: github-work
    agent_processing: false
    policy: Prefer short maintainer replies and never recommend closing user bug reports without evidence.
```

Custom ACP command specs are redacted in status, item detail, and state export output.
Accepted ACP target config values are either `agent: null`, a named registry target such as `agent: acp:mock-agent`, or a raw ACP server command string after `acp:`.
Raw command targets are shown as `acp:custom` in status and audit surfaces.

## First GitHub Workflow

GitHub and mock are the only required MVP source paths.
The bundled Gmail plugin, if present, is fixture-backed or demo-only for this release and should not be used as evidence of production Gmail readiness.

The first GitHub workflow is intentionally approval-first.
FirstPass can sync GitHub items, generate local recommendations, preview actions, and execute only after explicit approval.

1. Ensure GitHub credentials are available through the GitHub plugin's supported credential path.
2. Install and trust the GitHub plugin.
3. Add the GitHub source account.
4. Run a one-shot sync.
5. Review the queue.
6. Triage an item.
7. Inspect the recommendation and evidence.
8. Approve an action only after reviewing the preview.
9. Export the approval receipt for audit.

Commands:

```sh
firstpass plugin add github --trust
firstpass source add github \
  --account work \
  --trust \
  --config username=<github-login> \
  --config explicit_repos=<owner>/<repo>
firstpass source sync <source-account-id>
firstpass list
firstpass view <item-id>
firstpass triage <item-id>
firstpass view <item-id>
firstpass preview <recommendation-id> --option <option-id>
firstpass approve <recommendation-id> --option <option-id> --confirm-previewed
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
