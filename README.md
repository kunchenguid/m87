<h1 align="center">firstpass</h1>

<p align="center">
  <a href="https://github.com/kunchenguid/firstpass/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/firstpass/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/firstpass/actions/workflows/release-please.yml"
    ><img
      alt="Release"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/firstpass/release-please.yml?style=flat-square&label=release"
  /></a>
  <a href="https://www.npmjs.com/package/firstpass"
    ><img
      alt="npm"
      src="https://img.shields.io/npm/v/firstpass?style=flat-square"
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

`firstpass` splits the work.
A local daemon syncs your sources, an AI agent reads each item and recommends what to do, and the recommendation sits in a queue.
Nothing source-visible happens until you preview the exact outgoing action and explicitly confirm it.

- **Local-first** - the queue, daemon, SQLite database, and ACP sessions all live under `~/.firstpass`.
  No hosted backend.
- **Preview-then-approve** - the agent only recommends.
  Every external write waits behind a preview and an explicit `--confirm` gate; destructive actions need `--confirm-destructive`.
- **Pluggable sources** - GitHub issues and PRs out of the box, plus a documented plugin contract for adding trusted sources of your own.

## Quick Start

Run the guided setup in a terminal:

```sh
$ firstpass init
```

The wizard creates local state, discloses the ACP agent boundary, offers GitHub or skip, and defaults to installing the managed daemon service.
For scripts or CI, use flags instead of prompts:

```sh
$ firstpass init --yes \
  --agent auto \
  --plugin github \
  --github-repo <owner>/<repo>
$ firstpass sync
$ firstpass
```

External writes still wait behind preview and approval:

```sh
$ firstpass preview <recommendation-id>
$ firstpass approve <recommendation-id> --confirm
```

Run `firstpass` with no arguments in a terminal to open the live interactive inbox instead.

## Install

**npm (global)**

```sh
npm install -g firstpass
firstpass --version
```

**From source**

```sh
git clone https://github.com/kunchenguid/firstpass
cd firstpass
npm install -g .   # builds dist/ via prepack, then installs the `firstpass` binary
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
                                            preview  ◄───┘  (the gate)
                                                │
                                          approve --confirm
                                                │
                              ┌─────────────────┴─────────────────┐
                              ▼                                   ▼
                      source-visible action              automation job (draft PR)
                              │                                   │
                              ▼                                   ▼
                          audit trail                       reviewable PR
```

- **The daemon is the sole actor** - syncing, triage, and writes all flow through one background process so there is a single source of truth and one audit trail.
- **Approval is preview-then-confirm** - `preview` renders the precise effect; `approve --confirm` is the one human gate before anything reaches a source.
- **Agent is ACP-pluggable** - `firstpass` auto-detects an installed provider CLI (`claude`, then `codex`, then `opencode`) as its `acp:` target, or you set one explicitly in config.
- **Automation jobs stay reviewable** - approving a fix option queues a coding-agent job that the daemon runs into a draft pull request.
  It never merges for you.

## CLI Reference

| Command                          | Description                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `firstpass init`                 | Open guided setup on a TTY, or initialize local state        |
| `firstpass status`               | Show resolved agent, plugins, queue, and inbox status        |
| `firstpass sync`                 | Nudge the daemon to sync + triage all active plugins now     |
| `firstpass list`                 | List the active review inbox                                 |
| `firstpass view <item>`          | Show one item and its recommendation detail                  |
| `firstpass open <item>`          | Print the item's source URL                                  |
| `firstpass copy-handoff <item>`  | Print a copyable agent handoff prompt for one item           |
| `firstpass preview <rec>`        | Preview what approving an option would do (the gate)         |
| `firstpass approve <rec>`        | Approve an option - the one human gate                       |
| `firstpass triage <item>`        | Triage one newly synced item                                 |
| `firstpass rerun <item>`         | Supersede the recommendation and re-triage an item           |
| `firstpass dismiss <item>`       | Dismiss an item                                              |
| `firstpass mark-handled <item>`  | Mark an item handled                                         |
| `firstpass snooze <item> <dur>`  | Snooze an item until later (e.g. `1d`, `4h`)                 |
| `firstpass plugin ...`           | `add`, `list`, `configure`, `sync`, `doctor` source plugins  |
| `firstpass job ...`              | `list`, `view`, `attach` automation jobs                     |
| `firstpass daemon ...`           | `start`, `stop`, `status`, `restart`, `install`, `uninstall` |
| `firstpass audit export`         | Export the action audit trail                                |
| `firstpass audit receipt <id>`   | Show a receipt for an approval                               |
| `firstpass state export\|import` | Portable, secret-redacted state export/import                |
| `firstpass retention cleanup`    | Delete expired prompt contexts                               |
| `firstpass update [--check]`     | Check for and install a newer release from npm               |

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
| `init`                     | `--install-service`           | Install the managed daemon service                    |
| `init`                     | `--no-install-service`        | Opt out of the managed daemon service                 |
| `init`                     | `--start-daemon`              | Start a detached daemon without a service             |
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
firstpass init --yes \
  --plugin github \
  --github-repo <owner>/<repo>
```

Manual plugin setup is still available:

```sh
firstpass plugin add github
firstpass plugin configure github \
  --config username=<github-login> \
  --config explicit_repos=<owner>/<repo>
firstpass plugin doctor                 # confirm the daemon resolves your gh credentials
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

Config lives at `~/.firstpass/config.yaml` by default.
Set `FIRSTPASS_STATE_DIR` to change where the SQLite database, plugin state, ACP sessions, daemon PID, and retained artifacts are stored.

```yaml
agent: null # auto-detect a provider CLI (claude, then codex, then opencode); or set an acp: target
poll_interval: 300
acp_registry_overrides: {}
plugins: {}
```

If `~/.firstpass/AGENTS.md` exists, its contents are passed to every triage as a user policy, so you can steer recommendations globally.
Run `firstpass status` to see the resolved agent.

## Running As A Service

```sh
firstpass daemon run            # foreground; logs every sync/triage/warn until Ctrl-C
firstpass daemon start          # detached background process
firstpass daemon status         # report whether the daemon is running
firstpass daemon install        # managed OS service: launchd / systemd --user / schtasks
firstpass daemon uninstall
```

A managed daemon launched from a GUI context inherits a minimal `PATH`, so `firstpass` resolves your login-shell environment at startup to find `gh`, `git`, and provider CLIs.
Set `FIRSTPASS_SKIP_SHELLENV=1` to disable that resolution.

## Development

```sh
pnpm install
pnpm run build      # bundle src/ -> dist/cli.js via esbuild
pnpm run lint       # eslint
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest
node src/cli/index.js <command>  # run from source, no build needed
```

Contributions to `main` must be pushed through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) - see [CONTRIBUTING.md](CONTRIBUTING.md).
