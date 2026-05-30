<h1 align="center">m87</h1>

<p align="center">
  <a href="https://github.com/kunchenguid/m87/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/m87/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/m87/actions/workflows/release-please.yml"
    ><img
      alt="Release"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/m87/release-please.yml?style=flat-square&label=release"
  /></a>
  <a href="https://www.npmjs.com/package/@kunchenguid/m87"
    ><img
      alt="npm"
      src="https://img.shields.io/npm/v/@kunchenguid/m87?style=flat-square"
  /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">An AI triages your GitHub inbox.<br />You approve before anything ships.</h3>

Your issues and pull requests pile up faster than you can read them.
You could hand the whole thing to an agent, but then it is commenting, closing, and merging on your behalf while you are not looking - and that is exactly the part you do not want to give away.

`m87` splits the work.
A local daemon syncs your sources, an AI agent reads each item and recommends what to do, and the recommendation sits in a queue.
Nothing source-visible happens until you review the exact outgoing action and explicitly approve it.

- **Local-first** - the queue, daemon, SQLite database, and ACP sessions all live under `~/.m87`.
  No hosted backend.
- **Preview-then-approve** - the agent only recommends.
  Every external write waits behind a preview and explicit approval; CLI approval uses `--confirm`, and destructive actions need `--confirm-destructive`.
- **Pluggable sources** - GitHub issues and PRs out of the box, plus a documented plugin contract for adding trusted sources of your own.

## Quick Start

Run the guided setup in a terminal:

```sh
$ m87 init
```

The wizard creates local state, lets you use auto-detect or pick a detected AI agent, connects GitHub or skips source setup, and finishes by choosing whether M87 runs in the background at login, for this session only, or later.
For scripts or CI, use flags instead of prompts:

```sh
$ m87 init --yes \
  --agent auto \
  --plugin github \
  --github-repo <owner>/<repo>
$ m87 sync
$ m87
```

External writes still wait behind preview and approval when using the CLI:

```sh
$ m87 preview <recommendation-id>
$ m87 approve <recommendation-id> --confirm
```

Run `m87` with no arguments in a terminal to open the live interactive inbox instead.
Use ↑/↓ to move between items, press `1`-`9` to select an option, review the WILL DO detail, then press `a` to approve the selected option.
Use `j`/`k` to scroll long WILL DO details.
Press `i` for queue details, startup help, and other inbox info; press `i` or Esc to return.

## Install

**npm (global)**

```sh
npm install -g @kunchenguid/m87
m87 --version
```

**From source**

```sh
git clone https://github.com/kunchenguid/m87
cd m87
npm install -g .   # builds dist/ via prepack, then installs the `m87` binary
```

To hack on the code without installing, run it straight from source with `node src/cli/index.js <command>` (see [Development](#development)).

## How It Works

The daemon is the only worker.
It owns sync, triage, action execution, and automation jobs - the CLI and TUI just emit intents and read state.

```
  sources (github, plugins, ...)
          │  daemon sync
          ▼
        items ───────► agent triage (ACP) ───────► recommendation
                                                         │
                                                         ▼
                                                    inbox / list
                                                          │
                                      preview / WILL DO  ◄─┘  (the gate)
                                                 │
                                         explicit approval
                                  (TUI `a` or CLI `--confirm`)
                                                 │
                              ┌─────────────────┴─────────────────┐
                              ▼                                   ▼
                      source-visible action              automation job (draft PR)
                              │                                   │
                              ▼                                   ▼
                          audit trail                       reviewable PR
```

- **The daemon is the sole actor** - syncing, triage, and writes all flow through one background process so there is a single source of truth and one audit trail.
- **Approval is preview-then-approve** - the CLI `preview` command and the TUI WILL DO detail render the precise effect before a human approval reaches a source.
- **Agent is ACP-pluggable** - `m87` auto-detects an installed provider CLI (`claude`, then `codex`, then `opencode`) as its `acp:` target, or you set one explicitly in config.
- **Automation jobs stay reviewable** - approving a fix option queues a coding-agent job that the daemon runs into a draft pull request.
  It never merges for you.

## CLI Reference

| Command                    | Description                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `m87 init`                 | Open guided setup on a TTY, or initialize local state        |
| `m87 status`               | Show resolved agent, plugins, queue, and inbox status        |
| `m87 sync`                 | Nudge the daemon to sync + triage all active plugins now     |
| `m87 list`                 | List the active review inbox                                 |
| `m87 view <item>`          | Show one item and its recommendation detail                  |
| `m87 open <item>`          | Print the item's source URL                                  |
| `m87 copy-handoff <item>`  | Print a copyable agent handoff prompt for one item           |
| `m87 preview <rec>`        | Preview what approving an option would do (the gate)         |
| `m87 approve <rec>`        | Approve an option - the one human gate                       |
| `m87 triage <item>`        | Triage one newly synced item                                 |
| `m87 rerun <item>`         | Supersede the recommendation and re-triage an item           |
| `m87 dismiss <item>`       | Dismiss an item                                              |
| `m87 mark-handled <item>`  | Mark an item handled                                         |
| `m87 snooze <item> <dur>`  | Snooze an item until later (e.g. `1d`, `4h`)                 |
| `m87 plugin ...`           | `add`, `list`, `configure`, `sync`, `doctor` source plugins  |
| `m87 job ...`              | `list`, `view`, `attach` automation jobs                     |
| `m87 daemon ...`           | `start`, `stop`, `status`, `restart`, `install`, `uninstall` |
| `m87 audit export`         | Export the action audit trail                                |
| `m87 audit receipt <id>`   | Show a receipt for an approval                               |
| `m87 state export\|import` | Portable, secret-redacted state export/import                |
| `m87 retention cleanup`    | Delete expired prompt contexts                               |
| `m87 update [--check]`     | Check for and install a newer release from npm               |

### Flags

| Command                    | Flag                          | Description                                           |
| -------------------------- | ----------------------------- | ----------------------------------------------------- |
| `init`                     | `--yes`                       | Apply setup defaults without prompts                  |
| `init`                     | `--wizard`                    | Force the interactive setup wizard                    |
| `init`                     | `--agent <target>`            | `auto` or an explicit `acp:<target>`                  |
| `init`                     | `--plugin github\|skip\|none` | Configure GitHub or skip source setup                 |
| `init`                     | `--github-repo <repo...>`     | Sync explicit `owner/repo` sources                    |
| `init`                     | `--github-username <login>`   | GitHub login for discovered scopes                    |
| `init`                     | `--github-owned`              | Sync repositories owned by the GitHub user            |
| `init`                     | `--github-public-owned`       | Sync public repositories owned by the user            |
| `init`                     | `--github-public-starred`     | Sync public owned repositories starred by user        |
| `init`                     | `--github-authored-external`  | Sync authored issues and PRs outside configured repos |
| `init`                     | `--install-service`           | Start now and launch at login                         |
| `init`                     | `--no-install-service`        | Do not start in the background yet                    |
| `init`                     | `--start-daemon`              | Start now for this session only                       |
| `preview`                  | `--option <selector>`         | Pick an option by id or position                      |
| `approve`                  | `--option <selector>`         | Pick an option by id or position                      |
| `approve`                  | `--confirm`                   | Confirm external-write actions                        |
| `approve`                  | `--confirm-destructive`       | Confirm destructive actions                           |
| `rerun`                    | `--instructions <text>`       | Extra instructions for the agent                      |
| `plugin add` / `configure` | `--config <k=v...>`           | Set plugin configuration pairs                        |
| `daemon run`               | `--once`                      | Process the queue once and exit                       |
| `update`                   | `--check`                     | Only check the registry; never install                |

## Sources

### GitHub

The bundled GitHub plugin syncs issues and pull requests through `gh`, and supports comments, close/reopen, PR reviews, and merges.

```sh
gh auth status || gh auth login
m87 init --yes \
  --plugin github \
  --github-repo <owner>/<repo>
```

Manual plugin setup is still available:

```sh
m87 plugin add github
m87 plugin configure github \
  --config username=<github-login> \
  --config explicit_repos=<owner>/<repo>
m87 plugin doctor                 # confirm the daemon resolves your gh credentials
```

`gh` must be authenticated in the same environment the daemon runs under.
Configure at least one source (`explicit_repos`, `owned_repos=true`, `repo_conditions`, or `authored_external=true`), or sync completes with an empty inbox.

Every item is stamped with a **role**: _maintainer_ items (repos you own or configure) expose all actions including `merge` and `review`; _contributor_ items (things you authored elsewhere, via `authored_external`) carry a `[contrib]` badge and only offer comment/close.

Common GitHub plugin config keys:

| Key                   | Meaning                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `username`            | GitHub login to use when resolving owned repos and authored external work.                             |
| `explicit_repos`      | Comma-separated `owner/repo` list to sync.                                                             |
| `owned_repos`         | `true` to sync repositories owned by `username`.                                                       |
| `repo_conditions`     | Comma-separated discovery filters: `all_owned`, `all_public_owned`, or `all_public_owned_and_starred`. |
| `authored_external`   | `true` to sync issues and PRs authored by `username` outside configured repositories.                  |
| `exclude_repos`       | Comma-separated `owner/repo` list to skip.                                                             |
| `max_repos`           | Maximum repositories to sync when discovering repos.                                                   |
| `sync_limit_per_repo` | Maximum issues or pull requests to fetch per repository.                                               |
| `lookback_days`       | Activity lookback window in days.                                                                      |
| `activity_probe`      | `true` to probe extra activity when selecting work.                                                    |

### Gmail

The bundled Gmail plugin is demo-only and fixture-backed in this release.
It does not perform live Gmail writes.

## Configuration

Config lives at `~/.m87/config.yaml` by default.
Set `M87_STATE_DIR` to change where the SQLite database, plugin state, ACP sessions, daemon PID, daemon log, and retained artifacts are stored.

```yaml
agent: null # auto-detect a provider CLI (claude, then codex, then opencode); or set an acp: target
poll_interval: 300
acp_registry_overrides: {}
plugins: {}
```

If `~/.m87/AGENTS.md` exists, its contents are passed to every triage as a user policy, so you can steer recommendations globally.
Run `m87 status` to see the resolved agent.

## Running As A Service

```sh
m87 daemon run            # foreground; logs every sync/triage/warn until Ctrl-C
m87 daemon start          # detached background process
m87 daemon status         # report whether the daemon is running
m87 daemon install        # managed OS service: launchd / systemd --user / schtasks
m87 daemon uninstall
```

A detached or managed daemon writes operational logs to `~/.m87/daemon.log`, including startup, shutdown, loop errors, sync failures, and sync recovery.
Failed source syncs are retried with backoff instead of being parked forever; a plugin returns to active after a later successful sync.

A managed daemon launched from a GUI context inherits a minimal `PATH`, so `m87` resolves your login-shell environment at startup to find `gh`, `git`, and provider CLIs.
Set `M87_SKIP_SHELLENV=1` to disable that resolution.

## Development

```sh
pnpm install
pnpm run build      # bundle src/ -> dist/cli.js via esbuild
pnpm run lint       # eslint
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest
node src/cli/index.js <command>  # run from source, no build needed
```

End-to-end tests run the source CLI in tracked process groups and sweep any stranded CLI or plugin subprocesses after the run.

Contributions to `main` must be pushed through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) - see [CONTRIBUTING.md](CONTRIBUTING.md).
