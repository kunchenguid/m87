# firstpass PRD And Technical Design

## Pitch

`firstpass` (meaning "agent queue") is a local-first agentic queue that ingests updates from many personal and work sources, asks an agent to triage each item, and lets the user approve, edit, or dismiss recommended actions before anything is sent back.

The durable insight is the local recommendation and approval loop: agents investigate and recommend actions, humans decide, and remote writes happen only after approval.

People receive work across GitHub, email, Slack, Discord, X, Google Docs, calendar invites, support queues, and internal systems.
Each surface has its own notification model, unread state, labels, permissions, and reply UI.
`firstpass` gives the user one trusted review queue for items that need attention, with concise agent recommendations and safe action buttons.

The product runs locally by default, keeps private reasoning and drafts on the user's machine, and treats every source as a plugin.
The core does not understand GitHub, Gmail, X, or any other source in detail.
Plugins translate native systems into a shared set of primitives: configured scopes, items, events, context, capabilities, and executable actions.

## Problem

Modern knowledge workers are interrupted by scattered inbound work.
They repeatedly need to know whether something is new information or old noise, whether it requires them, what action to take, what context is needed, whether an agent can help, and what has already been handled.

Existing inboxes optimize for delivery, search, unread state, and platform-native actions.
They do not provide source-neutral triage, agent-generated recommendations, local private memory, or cross-source prioritization.

Raw agent access to every communication channel is dangerous.
The product needs a clear human approval boundary, durable audit trail, and source-specific permission model.

## Goals And Non-Goals

| Goals                                                                             | Non-goals                                                                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| One local-first inbox for action items from multiple sources.                     | Do not build a universal social client.                                                                              |
| Source integrations implemented as plugins, not core code.                        | Do not replace Gmail, GitHub, Slack, or X as full native clients.                                                    |
| Structured recommendations with multiple reasonable options when appropriate.     | Do not auto-send messages by default.                                                                                |
| Explicit human approval before visible external side effects.                     | Do not require a hosted backend for the single-user product.                                                         |
| No reliance on server-side labels, reactions, tags, read state, or custom fields. | Do not require every source to support the same actions.                                                             |
| Support sources with different activity models, permissions, and action types.    | Do not assume reliable unread state, labels, webhooks, or updated timestamps.                                        |
| Ergonomic plugin interface for agents and humans.                                 | Do not make the core understand source-specific concepts like pull requests, email labels, tweets, or Jira statuses. |
| Enough evidence for users to trust recommendations without opening every source.  | Do not optimize first for teams, shared queues, or delegated approvals.                                              |
| Private reasoning, drafts, and approval history local by default.                 |                                                                                                                      |
| Basic plugin trust model for first-party and third-party plugins.                 |                                                                                                                      |
| Prompt-context retention cleanup with broader retention controls planned later.   |                                                                                                                      |

## Users And Use Cases

| Persona                 | Description                                                                                                                                                                                      | Scope                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| High-context individual | OSS maintainers, founders, staff engineers, independent researchers, and developer advocates who maintain projects, communicate across many tools, and value privacy, control, and traceability. | Primary.                      |
| Agentic operator        | Users already delegating to coding or research agents who want inbound messages turned into prompts, follow-up tasks, or approved replies.                                                       | Secondary.                    |
| Small team lead         | Users managing shared inbound work with assignment, shared policy, audit, and permissions.                                                                                                       | Later; outside initial scope. |

Core use cases:

- Triage GitHub issues and pull requests.
- Triage Gmail messages that need reply, archive, follow-up, or task creation.
- Triage X replies and DMs that deserve response, mute, block, or follow-up.
- Triage Slack or Discord mentions that require reply or task.
- Generate an agent handoff when the right action is a complex task.
- Dismiss, snooze, or ignore noisy sources locally without writing to the source.

## Product Principles

| Principle                       | Requirement                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local-first trust               | Run without a hosted control plane as a local daemon; use the local database for item history, recommendations, approvals, agent usage, and plugin state.                            |
| Human approval boundary         | Agents investigate and recommend; only users approve side effects; approval should be fast but explicit.                                                                             |
| Source-neutral core             | Core owns scheduling, storage, recommendation lifecycle, approval lifecycle, UI, and agent orchestration; plugins own sync, context, capabilities, action validation, and execution. |
| No required remote tracking     | Core tracking must work without source-side markers; plugins may optionally expose remote markers.                                                                                   |
| Capabilities over enums         | Plugins declare action types, schemas, safety properties, and preview behavior; core does not hard-code every possible action.                                                       |
| Evidence before recommendations | Recommendations cite source events, context snippets, attachments, or related objects so users do not trust unsupported summaries.                                                   |
| Boring, scriptable interfaces   | Plugins are ordinary executables with a small JSON protocol that is easy to test, mock, and implement with agents.                                                                   |

## Success Metrics

- Recommendations approved with no edits.
- Recommendations approved after edits.
- Median time from item ingestion to user decision.
- Median time saved per approved action, estimated from user feedback or lightweight prompts.
- Active configured sources per user.
- Third-party plugins created without core changes.
- False positive rate: surfaced items dismissed as not requiring attention.
- False negative rate: missed items discovered later.
- Remote action failure rate by plugin and action type.
- Recommendation rerun rate and reasons.

## Scope

The MVP should prove the generic abstraction with one meaningfully rich source before adding more source types.
GitHub is the first real plugin because it has code context, structured objects, stateful actions, and lower privacy risk than email.
Gmail is deferred from the MVP and any bundled Gmail plugin should be treated as fixture-backed or demo-only until a later production hardening round.

| MVP includes                                                                         | MVP excludes                         | V1 adds                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------- |
| Local daemon polling configured plugins.                                             | Hosted sync service.                 | First-party X plugin if API access is viable.                                   |
| SQLite database under `~/.firstpass`.                                                | Mobile app.                          | Attachment summarization pipeline.                                              |
| Commander CLI and Ink terminal inbox UI.                                             | Team inboxes.                        | Source-specific prompt packs.                                                   |
| Bundled plugin installation, manifest validation, and manifest metadata persistence. | Webhook server.                      | Per-source and per-account policies.                                            |
| Source plugin CLI protocol over JSON stdin/stdout.                                   | Cross-device sync.                   | Approval receipts and action audit export.                                      |
| Item sync with plugin-owned fingerprints and explicit pagination/error semantics.    | Fully autonomous sending.            | Plugin sandboxing, signing, and permission enforcement.                         |
| Agent recommendation generation using plugin context and action schemas.             | Plugin marketplace.                  | Import/export of local state.                                                   |
| ACP agent runtime through bundled `acpx/runtime`; no native agent adapters.          | Complex workflow automation builder. | Optional webhook bridge for near-realtime sync.                                 |
| Multi-option recommendations with structured evidence citations.                     |                                      | Optional encrypted cloud backup, not required for local operation.              |
| Approve, edit, dismiss, snooze, open-source-item, and rerun flows.                   |                                      |                                                                                 |
| Plugin-executed remote actions after approval.                                       |                                      |                                                                                 |
| Local-only handled state with activity watermark retriage and state transitions.     |                                      |                                                                                 |
| Prompt-context TTL defaults and cleanup.                                             |                                      | Configurable retention for raw context, drafts, attachments, and audit records. |
| Mock plugin for tests and demos.                                                     |                                      |                                                                                 |
| First-party GitHub plugin.                                                           |                                      | First-party Gmail plugin after MVP production hardening.                        |

## User Experience

### Setup

```sh
firstpass init
firstpass plugin add github
firstpass plugin configure github --config explicit_repos=owner/repo
firstpass daemon start
firstpass
```

The exact installation mechanism can vary, but the conceptual model is stable: core first, then a configured plugin.
A configured plugin is the unit of scope; there is no separate source-account object.

### Inbox And Detail

The default UI is a review queue.
Each row shows source, item type, sender or actor, title or subject, recommendation state, waiting state, and freshness.
After more plugins exist, the queue can contain rows like:

```text
gmail/work     email_thread   alice@example.com     Reply: contract draft          action recommended
github/oss     pull_request   contributor42         Fix failing Windows test       fix suggested
x/personal     reply          @person               Clarify your post on agents    draft reply
```

The detail pane shows normalized item metadata, plugin-rendered source context, agent rationale grounded in visible context, ordered recommendation options, proposed actions, action preview and safety warnings, token usage and model, and plugin execution status.

Core actions:

- Approve selected option.
- Edit proposed action payloads before approval.
- Dismiss recommendation locally.
- Snooze item locally.
- Rerun triage with user instructions.
- Open item in native source UI.
- Copy agent handoff prompt.
- Queue an automation job.
- Mark local item handled with no remote write.

Recommended CLI surface:

```sh
firstpass                    # open TUI
firstpass list               # list active recommendations
firstpass status             # daemon and source status
firstpass triage <item-id>   # rerun triage for one item
firstpass approve <rec-id>   # approve from CLI
firstpass dismiss <item-id>  # dismiss locally
firstpass snooze <item-id> 7d
firstpass plugin configure <plugin> --config key=value
firstpass plugin sync <plugin>
firstpass plugin list
firstpass plugin doctor
firstpass daemon start
firstpass daemon stop
```

## Product Model

| Concept        | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source plugin  | First-party or third-party executable implementing the `firstpass` plugin protocol; invoked by the core with command names and JSON payloads. A configured plugin is the unit of scope: it owns a single scope `config`, a single opaque sync fingerprint baseline, rate-limit state, and plugin-owned credentials. Running multiple identities of one source (two GitHub logins, two Gmail mailboxes) is the plugin's own responsibility, expressed inside its `config` while keeping `external_id`s unique; the core does not model separate accounts. |
| Item           | Source-neutral object that may need triage, such as a GitHub PR, Gmail thread, X reply, Linear issue, or Slack thread; stored as a normalized envelope plus plugin metadata JSON.                                                                                                                                                                                                                                                                                                                                                                        |
| Event          | Source-side change that may affect attention, such as a new email, PR review, tweet reply, or status change; core needs stable IDs, timestamps, actor identity, and plugin attention signal.                                                                                                                                                                                                                                                                                                                                                             |
| Recommendation | One agent run against one item at one observed activity watermark; contains one or more options; only one active recommendation per item.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Option         | Complete proposed next step with title, rationale, confidence, waiting state, proposed plugin actions, and optional automation jobs.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Action         | Plugin-defined remote operation such as reply, archive, close, merge, label, mute, block, assign, or create draft; core stores and displays it while plugin validates and executes it.                                                                                                                                                                                                                                                                                                                                                                   |
| Automation job | Longer-running operation triggered by an option, such as a GitHub coding-agent fix, a Gmail long-response draft using related documents, or a Linear spec or child-issue creation.                                                                                                                                                                                                                                                                                                                                                                       |

## Technical Architecture

```text
source plugins             -- JSON CLI protocol -->      firstpass daemon
github, gmail, x, linear                                  sync, triage, jobs, IPC
                                                                  |
                                                                  v
SQLite database             <-- local storage ------      items, events, recs, audit
                                                                  |
                                                                  v
ACP runtime                 <-- structured prompts -      acpx/runtime targets
                                                                  |
                                                                  v
CLI / TUI                   <-- recommendations ---      approve, edit, rerun
                                                                  |
                                                                  v
source plugins              <-- approved actions ---      validate, preview, execute
```

Responsibilities:

| Core                                                                                               | Plugins                                                     |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Load config.                                                                                       | Authenticate with the source or locate source credentials.  |
| Discover plugins and validate manifests.                                                           | Declare capabilities and action schemas.                    |
| Schedule syncs.                                                                                    | Sync changed items and events.                              |
| Persist plugin config, fingerprint baselines, items, events, recommendations, approvals, and jobs. | Maintain source-specific diff state in opaque plugin state. |
| Decide triage eligibility using local watermarks and plugin attention hints.                       | Fetch complete item context for prompt assembly.            |
| Build prompts from core policy, user policy, plugin context, evidence catalog, and action schemas. | Render compact human-readable context for the UI.           |
| Invoke ACP targets through `acpx/runtime` and validate recommendation structure.                   | Render compact agent-readable context for prompts.          |
| Render recommendations in CLI and TUI.                                                             | Validate action payloads before approval.                   |
| Persist user approvals and edits.                                                                  | Preview action effects where possible.                      |
| Invoke plugin action validation, preview, and execution.                                           | Execute approved actions.                                   |
| Maintain audit trail.                                                                              | Return stable source URLs for native clients.               |
| Emit daemon status and live UI events over IPC.                                                    |                                                             |

## Tech Stack

`firstpass` should be installable with ordinary npm tooling and must not require Bun.

| Area               | Choice                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Runtime            | Node.js 22.13+.                                                                                 |
| Source language    | Plain ESM JavaScript.                                                                           |
| Typechecking       | `tsc --noEmit` with `allowJs` and `checkJs`; no JSDoc type annotations in implementation files. |
| Package manager    | `pnpm` for development; published package works with `npm install -g firstpass`.                |
| CLI                | Commander for scriptable commands.                                                              |
| Human TUI          | Ink with React, written in JS, for a screenshot-worthy terminal inbox.                          |
| Database           | SQLite via `better-sqlite3`.                                                                    |
| Config             | YAML via `js-yaml`; config keys use snake_case.                                                 |
| Runtime validation | Zod for internal config and protocol objects; Ajv for plugin-declared JSON Schemas.             |
| Agent runtime      | Bundled `acpx/runtime`; no native agent adapters in core.                                       |
| Tests              | Vitest with mock plugin executables and fixture directories.                                    |
| Build              | Bundle the JS CLI with `tsdown` or `esbuild`; keep source in JS.                                |

The CLI has two audiences.
Scriptable commands should produce compact structured output for agents and automation.
The Ink TUI is the polished human surface and should be designed as a RICEd local command center: source queue, recommendation detail, evidence cards, action preview, audit/status panels, keyboard-first navigation, strong theming, and careful visual treatment for external-write and destructive actions.

## Plugin Protocol

The protocol is command-oriented and JSON-based.
Every command accepts one JSON object on stdin and returns one JSON object on stdout.
Logs go to stderr as structured lines or plain text.
Exit code `0` means protocol success, nonzero means transport or plugin failure, and application-level failures should return JSON with an error object when possible.

Recommended command shape:

```sh
firstpass-src-github manifest
firstpass-src-github doctor
firstpass-src-github configure
firstpass-src-github sync
firstpass-src-github fetch
firstpass-src-github validate-action
firstpass-src-github preview-action
firstpass-src-github execute-action
firstpass-src-github prepare-automation-workspace
firstpass-src-github submit-automation-workspace
firstpass-src-github detect-automation-pr
```

Plugin executable names must follow the `firstpass-src-xyz` convention.
The core passes `--protocol-version` to each command.
Plugins return the protocol version they actually used.

### Plugin Trust Model

Executable plugins are not a hard security boundary.
A plugin can read local files, make network calls, and perform source-side writes with any credentials it can access, including during commands that are nominally read-only.
The approval boundary protects users from agent-selected actions executed by honest plugins; it does not protect users from malicious or compromised plugin code.

MVP must document that tradeoff instead of pretending it is solved by the protocol.
This is not sandbox enforcement.
Plugin records persist the binary path, resolved version, and full manifest metadata, including publisher, requested source scopes, declared capabilities, and action safety levels.
First-party plugins can be marked as bundled or verified, but their manifests still include source scopes and write-capable actions.

The product should educate users to prefer the narrowest practical source credentials, inspect OAuth scopes before authorizing a plugin, avoid untrusted third-party plugins for sensitive accounts, and disable write scopes if they only want read-only recommendations.
Requiring separate read and write credentials is not an MVP requirement because that adds too much setup friction.
Later versions can add sandboxing, signed plugins, permission prompts, and stronger provenance checks.

### Manifest

The manifest declares source identity, protocol version, configuration schema, trust metadata, requested source scopes, item types, action types, and capabilities.
Protocol-required manifest fields:

| Field              | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `protocol_version` | Protocol version such as `firstpass.plugin.v2`.                     |
| `plugin`           | `id`, `version`, optional `display_name`, and optional `publisher`. |

Recommended manifest metadata fields:

| Field              | Meaning                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `trust`            | Distribution metadata such as `first_party`, `third_party`, `bundled`, explicit path, or package source. |
| `requested_scopes` | Source credential scopes with human-readable purposes.                                                   |
| `capabilities`     | Array of declared capability metadata.                                                                   |
| `item_types`       | Source item type IDs with display names.                                                                 |
| `action_types`     | Plugin action catalog.                                                                                   |

Each action type declares `type`, `display_name`, `description`, `safety`, `idempotency`, strict JSON `schema`, and prompt examples.
`safety` must be one of `local_only`, `source_private`, `external_write`, or `destructive`.
`idempotency` should state whether the action uses `client_token`, `natural_key`, or best-effort behavior.

### Sync And Context Commands

`sync` returns recent events, updated opaque fingerprints, and explicit sync progress metadata.
The plugin may maintain private state in its own files, but the core persists fingerprints so backups and status are understandable.
Fingerprints are committed only after the core has durably persisted every returned event and warning in the response.

`sync` input fields are the plugin's scope `config` and prior `fingerprints`; there is no `account_id`.
`sync` output fields are `status`, `events`, next `fingerprints`, optional `has_more`, optional `retry_after_seconds`, and `warnings`.
Each event includes `external_id`, `lifecycle`, source item fields such as `item_type`, `title`, `actor`, `state`, `url`, `activity_at`, `activity_id`, `fingerprint`, optional `attention`, opaque `payload`, optional `occurred_at`, and optional `metadata`.
The `attention` object includes `should_surface`, `reason`, `waiting_on`, and optional `priority_hint`.

`status` is one of `complete`, `partial`, `rate_limited`, `permission_denied`, or `error`.
`complete` means the fingerprints cover all source activity known to the plugin for this request window.
`partial` means the core should persist the response, save the returned fingerprints, and immediately schedule another sync because `has_more` is true or the plugin hit a bounded page.
`rate_limited` means the core should persist any returned data but wait at least `retry_after_seconds` before retrying the plugin.
`permission_denied` means credentials are missing or no longer have the required scopes, so the core should mark the plugin unhealthy and avoid repeated sync attempts until the user reconfigures it.
`error` means the plugin could not complete sync and the core should mark the plugin unhealthy with the returned warning.

Pagination is plugin-owned.
The core only treats a sync cycle as caught up when the latest response is `complete` and `has_more` is false.
Plugins should make fingerprints monotonic and idempotent so repeated calls with the same fingerprints may return duplicate events without changing meaning.
Plugins should include deletion or unavailable-item events when the source exposes them, but core behavior cannot rely on every source reporting deletions.
Source clock skew is handled by plugin fingerprints first and timestamps second; the core uses `activity_at`, `activity_id`, and `content_fingerprint` together rather than trusting timestamps alone.

`fetch` returns full source context for triage, including raw-ish structured data, rendered prompt text, attachment metadata, related object references, redaction hints, and evidence references.
Output should separate human UI context from agent prompt context and may include compact and full variants.
Evidence references are stable within the fetched context and can point at source events, source objects, snippets, attachments, URLs, or related local files.

`validate-action` checks whether an action payload is well-formed, permitted, and still applicable to current source state.
It runs before showing approval and again immediately before execution.

`preview-action` returns a source-specific human-readable description of what will happen.
Email previews may render recipients, subject, and body; GitHub previews may render comment, labels, close, merge, or review request.

`execute-action` performs one approved remote action.
The core passes an approval ID and idempotency key.
Plugins use the idempotency key when supported and otherwise make best-effort natural-key checks.

## Recommendation And Prompting

Recommendations are source-neutral and action-centric.
The agent must not output hard-coded state changes like `merge` or `request_changes` unless those action types are declared by the plugin.
The top-level `summary` is a concise summary of the original source item or situation, not a summary of the recommendation itself.
Each option's `title` is the short summary of that recommendation option.
The recommendation also carries a structured evidence catalog so the UI can show exactly why an option exists without parsing free-form rationale.
Options reference evidence IDs from the catalog instead of embedding long quoted source text repeatedly.

The core recommendation object is strict JSON with `additionalProperties: false` and required top-level fields `summary`, `evidence`, and `options`.
`summary` is a string.
`evidence` is an array of objects with required `id`, `kind`, `source_ref`, and `summary`; optional `quote` and `url`; and `kind` in `event`, `snippet`, `attachment`, `related_object`, `source_url`, or `local_file`.
`options` is a non-empty array.
Each option requires `title`, `rationale`, `evidence_refs`, `confidence`, `waiting_on`, and `actions`.
`confidence` is `low`, `medium`, or `high`.
`waiting_on` is `user`, `other`, `source`, `agent`, or `none`.
Each action requires `id`, `action_type`, `params`, `description`, and `required`, with optional `depends_on` action IDs.
Options may include `automation` with required `kind` and `prompt`.

The core validates the outer schema.
Each plugin validates every action payload against its declared action schema.
If validation fails, the recommendation is marked invalid and either repaired by a follow-up agent call or surfaced as an error.
The core also validates that every option `evidence_refs` value exists in the top-level evidence catalog and that every action dependency points at another action ID in the same option.
Action safety levels are supplied by the plugin manifest and validation result, not by the agent.
For execution, actions with `required: true` must all succeed before the item is marked handled for the activity watermark.
Actions with `required: false` may fail without blocking handling, but their failures still appear in the audit trail and item detail.

Prompt sections:

- Core policy: act as the user's triage assistant, propose options, do not claim actions were taken, respect approval boundary.
- User policy: local instructions from `~/.firstpass/AGENTS.md` or equivalent.
- Plugin policy: tone, ignore rules, escalation rules, and allowed actions.
- Plugin source context: item metadata, thread text, related objects, and source-specific caveats.
- Evidence catalog: stable IDs for events, snippets, attachments, URLs, and related objects that options can cite.
- Plugin action catalog: action types, descriptions, JSON schemas, and examples.
- Rerun instructions: user-provided private context for this run.

The prompt recommends one to three options when there are real alternatives, but the agent should choose however many next steps fit the situation.
It asks the agent to ground rationale in visible source context and prefers no remote action when confidence is low.

## Agent Runtime

MVP uses ACP as the only agent integration boundary.
`firstpass` depends on bundled `acpx/runtime`, accepts `agent: acp:<target-or-command>`, and does not implement native Claude, Codex, OpenCode, or Rovo Dev adapters in core.
Named ACP targets resolve through the bundled `acpx` registry plus user-configured `acp_registry_overrides`.
Raw custom ACP server commands may be supplied after `acp:`.
Raw command target redaction is applied only on surfaces that explicitly call the ACP target redactor; status output and state export can expose the configured command string, so custom ACP commands must not contain secrets.

The daemon creates one persistent ACP session per logical firstpass worker and stores ACP session state under `~/.firstpass/acp-sessions` or a run-specific child directory.
Each triage run starts a turn with the assembled prompt plus the recommendation JSON Schema as the final output contract.
The runtime streams assistant output, status events, and tool-call events to the daemon so the TUI can show progress without exposing noisy protocol mechanics.
The daemon parses the final output text as JSON, validates it against the recommendation schema, and retries or surfaces an invalid-recommendation error when parsing fails.

`firstpass` should follow this ACP posture:

- Use `createAcpRuntime`, `createAgentRegistry`, and `createFileSessionStore` from `acpx/runtime`.
- Use persistent ACP sessions keyed by stable run or worker IDs.
- Pass registry overrides into `createAgentRegistry({ overrides })`.
- Use `permissionMode: "approve-all"` and `nonInteractivePermissions: "deny"` unless ACP runtime semantics change.
- Track usage from ACP `used` status deltas when available.
- Fall back to prompt-length and tool-call-count token estimates when usage events are absent.
- Mark estimated usage clearly in status and recommendation detail.
- Log ACP lifecycle events without logging raw prompts by default.
- Redact raw ACP command targets from logs and user-facing errors.

Agent data leaves the machine when the configured ACP target sends it to a hosted model or remote service.
The UI and documentation must say this plainly when configuring an ACP target.
Local-first means `firstpass` does not require an `firstpass` hosted control plane; it does not mean every configured model runs locally.

## Local Tracking And Retriage

`firstpass` uses local watermarks instead of source-side labels or tags.
This is the key architectural difference from GitHub-specific triage.

For each item, the core stores latest observed `activity_at`, `activity_id`, `content_fingerprint`, latest recommendation watermark, latest approval watermark, local inbox state, snooze state, and matched ignore rules.

An item needs triage when the plugin says it should surface, when no active recommendation or handled record exists for the latest activity watermark, when latest activity is newer than recommendation or approval watermark, when the content fingerprint changed meaningfully, or when the user reruns triage.

An item does not need triage when it is locally dismissed, approved, or marked handled for the current activity watermark; snoozed until a future time without an urgent plugin override; or matched by a local ignore rule.

If the local database is deleted, source-side tracking can be lost.
That is acceptable for MVP because local-first privacy is more important than remote marker consistency.
Backup and export should come before cross-device state.

Item state is explicit and local.
The core stores the current state plus the activity watermark that state applies to.

| State                    | Meaning                                                                        | Entered by                                                       | Leaves when                                                           |
| ------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `new`                    | Item was ingested and has not been triaged for the current watermark.          | Sync upsert with attention signal.                               | Triage claim starts.                                                  |
| `triaging`               | The daemon claimed the item for context fetch and agent recommendation.        | Daemon worker claim.                                             | Recommendation succeeds, fails, or is cancelled.                      |
| `recommended`            | The item has one active valid recommendation for the current watermark.        | Recommendation insert.                                           | User approves, dismisses, snoozes, reruns, or new activity arrives.   |
| `invalid_recommendation` | Agent output or plugin action validation failed.                               | Schema or validation failure.                                    | Rerun succeeds, user dismisses, or new activity arrives.              |
| `approved_pending`       | User selected an option and the core is validating or executing actions.       | Approval intent persisted.                                       | All required actions finish or an error occurs.                       |
| `handled`                | The item is locally complete for the stored watermark.                         | Required approved actions succeed or user marks handled locally. | New activity exceeds the handled watermark.                           |
| `dismissed`              | User dismissed the item locally for the stored watermark.                      | Dismiss action.                                                  | New activity exceeds the dismissed watermark or user reruns.          |
| `snoozed`                | Item is hidden until a local time unless urgent source attention overrides it. | Snooze action.                                                   | Snooze expires, urgent override arrives, or user unsnoozes.           |
| `ignored`                | Item matches a local ignore rule for the stored watermark.                     | Policy evaluation.                                               | Rule changes, user reruns, or new activity no longer matches.         |
| `action_error`           | At least one required approved action failed.                                  | Approval execution failure.                                      | User retries, edits and retries, dismisses, or marks handled locally. |

New source activity does not erase history.
It creates a new eligibility decision at a newer watermark and may supersede active recommendations while preserving old recommendations, approvals, and action results for audit.

Daemon cycle:

1. Load active configured plugins.
2. Invoke plugin `sync` with saved fingerprints for each configured plugin.
3. Upsert returned items.
4. Insert new events idempotently by plugin, item, and event external ID.
5. Save the returned fingerprints only after successful item and event persistence.
6. Compute local triage eligibility for changed items.
7. Claim a bounded number of eligible items for agent triage.
8. Fetch full context for each claimed item.
9. Build prompt and action schema.
10. Run the agent.
11. Validate recommendation and plugin action payloads.
12. Insert recommendation and supersede older active recommendation.
13. Emit IPC updates for the UI.

The core avoids source-specific deep probes.
Sources needing hidden-activity detection implement it inside `sync` or later expose a plugin-specific `refresh` capability.

### Attention Policy

MVP attention policy should be simple and dumb.
The product should avoid learned ranking, cross-source inference, and agent-decided inbox hiding until the deterministic loop is trusted.

The rule is: a source item enters the review queue when the plugin says `attention.should_surface: true` and the core has not locally hidden that item for the current activity watermark.

Responsibilities are deliberately narrow:

- Plugin decides source semantics: what changed, whether the source thinks the user probably needs to look, `attention.reason`, `waiting_on`, and optional `priority_hint`.
- Core applies source-neutral local state: enabled plugin, include and ignore rules, snooze, dismissed, handled, newer activity watermark, and recommendation validity.
- Agent explains and recommends actions for queued items; it does not decide whether an item should silently disappear from the queue.
- User fixes noise with explicit ignore rules, plugin config, dismiss, snooze, or mark handled.

Default sorting is deterministic:

1. Items with plugin `priority_hint: "urgent"` first.
2. Items whose snooze just expired before ordinary active items.
3. Newer `activity_at` before older `activity_at`.
4. Stable configured-plugin order as the final tie-breaker.

MVP does not infer rules from repeated dismissals.
It may show lightweight suggestions such as “you dismissed several Dependabot items,” but applying a rule is always explicit.
If attention quality is bad, the fix should be to improve the plugin's `attention` hints or add a visible local rule, not to hide more logic in the core.

Approval flow:

1. Persist approval intent with selected option and current item activity watermark.
2. Ask the plugin to validate each action against current source state.
3. Show new warnings if validation changed since recommendation time.
4. Execute actions according to declared dependencies, defaulting to the recommendation order.
5. Persist each action result.
6. Mark the item locally handled for the activity watermark if all required actions succeed.
7. Keep the item active with an error state if any required action fails.
8. Supersede the recommendation after successful handling or explicit dismissal.

The core treats each action as a separately auditable operation with an action ID, idempotency key, request payload, validation result, preview result, execution result, and error.
Actions may declare `depends_on` to force ordering within an option.
The core defaults to sequential execution because user communication actions are safety-sensitive and because rollback is usually not possible across remote systems.
Plugins should avoid recommending multi-action options that require atomicity unless the source can provide it.

Action safety levels:

- `local_only`: changes only local `firstpass` state.
- `source_private`: changes private source state such as archive, read, label, or draft.
- `external_write`: sends text or visible interaction to other people.
- `destructive`: closes, deletes, blocks, merges, or otherwise changes durable shared state.

The UI makes `external_write` and `destructive` visually distinct.
Config can allow per-source approval defaults, but MVP requires approval for all remote writes.

## Data Model

The exact schema can evolve, but the core tables should conceptually include:

| Table                    | Fields                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins`                | `id`, `binary_path`, `version`, `protocol_version`, `manifest_json`, `installed_at`, `last_checked_at`, `config_json`, `fingerprints_json`, `status`, `last_sync_at`, `last_error` (per-instance sync state lives here; there is no separate `source_accounts` table)                                                                                                              |
| `items`                  | `id`, `plugin_id`, `external_id`, `item_type`, `title`, `actor`, `state`, `url`, `activity_at`, `activity_id`, `content_fingerprint`, `attention_reason`, `attention_priority_hint`, `waiting_on`, `local_state`, `snoozed_until`, `metadata_json`, `source_event_id`, `created_at`, `updated_at`; unique on `(plugin_id, external_id)` and item id is `<plugin_id>:<external_id>` |
| `events`                 | `id`, `actor`, `occurred_at`, `created_at`, `entity`, `lifecycle`, `envelope_json`, `attention_json`, `payload_json`, `item_id`, `plugin_id`, `parent_event_id`, `root_event_id`, `depth`, `schema_version`, `dedup_key`                                                                                                                                                           |
| `prompt_contexts`        | `id`, `item_id`, `recommendation_id`, `retention_class`, `human_context_json`, `agent_context_json`, `evidence_json`, `redaction_hints_json`, `created_at`, `expires_at`, `deleted_at`                                                                                                                                                                                             |
| `agent_runs`             | `id`, `item_id`, `recommendation_id`, `source_event_id`, `agent_spec`, `acp_target_redacted`, `acp_session_key`, `status`, `tokens_in`, `tokens_out`, `usage_estimated`, `error`, `started_at`, `completed_at`                                                                                                                                                                     |
| `recommendations`        | `id`, `item_id`, `agent_run_id`, `source_event_id`, `summary`, `evidence_json`, `activity_at`, `content_fingerprint`, `created_at`, `superseded_at`                                                                                                                                                                                                                                |
| `recommendation_options` | `id`, `recommendation_id`, `position`, `title`, `rationale`, `evidence_refs_json`, `confidence`, `waiting_on`, `actions_json`, `automation_json`, `created_at`                                                                                                                                                                                                                     |
| `approvals`              | `id`, `recommendation_id`, `option_id`, `item_id`, `source_event_id`, `decision`, `edited_actions_json`, `idempotency_key`, `created_at`                                                                                                                                                                                                                                           |
| `action_results`         | `id`, `approval_id`, `item_id`, `plugin_id`, `action_id`, `action_type`, `required`, `depends_on_json`, `safety`, `status`, `validation_json`, `preview_json`, `request_json`, `result_json`, `error`, `source_event_id`, `started_at`, `completed_at`                                                                                                                             |
| `action_previews`        | `id`, `recommendation_id`, `option_id`, `item_id`, `plugin_id`, `action_id`, `action_type`, `required`, `depends_on_json`, `safety`, `validation_json`, `preview_json`, `request_json`, `edited_actions_json`, `created_at`                                                                                                                                                        |
| `jobs`                   | `id`, `item_id`, `recommendation_id`, `option_id`, `approval_id`, `kind`, `status`, `phase`, `prompt`, `metadata_json`, `error`, `source_event_id`, `created_at`, `started_at`, `updated_at`, `completed_at`                                                                                                                                                                       |
| `retention_policies`     | `id`, `scope`, `raw_context_ttl`, `prompt_ttl`, `draft_ttl`, `attachment_ttl`, `audit_ttl`, `created_at`, `updated_at`                                                                                                                                                                                                                                                             |

## Source Examples

GitHub should prove issues, pull requests, comments, labels, close/reopen, safe PR actions, code context, and optional user-requested remote triage markers without using labels as core tracking state.
Gmail should prove threads, drafts-first replies, archive/read/label actions, external-domain warnings, reply-all warnings, attachment warnings, and stricter retention defaults.
X should remain V1-only if API access is viable; support read-only mode if writes are unavailable and treat public replies as high-reputation-risk `external_write` actions.

## Configuration And Discovery

Global config lives at `~/.firstpass/config.yaml`.
Plugin credentials should not be stored in core config unless unavoidable.
Plugins should prefer OS keychain, existing CLIs, OAuth token stores, or their own encrypted files.

The config contains `agent`, `poll_interval`, `acp_registry_overrides`, and `plugins`.
The state directory comes from `FIRSTPASS_STATE_DIR` or defaults to `~/.firstpass`, and installed plugin config is stored with the plugin record.

MVP plugin installation is limited to bundled plugin IDs exposed by `firstpass plugin list`.
Third-party discovery from explicit config paths, `~/.firstpass/plugins`, or `PATH` executables named `firstpass-src-*` is future work.

The plugin command should be stable enough for third-party plugins in any language.
Bundling does not imply provenance or safety.
The core should store plugin source, scope, capability, and action metadata for installed plugins.

## Security, Privacy, And Observability

Requirements:

- Store data locally by default.
- Gate remote writes on approval.
- Show exact outgoing text before approval.
- Store action audit records.
- Store plugin source, scope, and capability information from installed plugin manifests.
- Avoid logging secrets.
- Redact plugin stderr in user-facing bug reports unless the user opts in.
- Clean up expired prompt contexts and keep broader retention controls future-compatible.
- Prefer drafts over sends for email by default.
- Prefer read-only plugin scopes during initial setup when writes are not needed.
- Keep sensitive plugin scopes out of hosted-agent prompts by using local ACP targets or by not triaging those plugins.
- Explain when configured ACP targets send prompt context to hosted model providers.

Plugin executable risk is handled by the plugin trust model above.

Retention defaults should support useful product behavior without hoarding source data forever.

| Data                                                                            | MVP default                                                                  | Why it is retained                                                                            | User controls                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Normalized item and event envelopes                                             | Keep until user deletes the plugin or local database.                        | Needed for watermarks, state transitions, audit, and false-positive or false-negative review. | Delete plugin, export/import, future compaction.                           |
| Raw or raw-ish fetched source context                                           | 30 days.                                                                     | Needed to inspect recommendations, rerun triage, and debug agent mistakes.                    | Per-source TTL: `never`, duration, or `keep`.                              |
| Rendered human context and evidence catalog                                     | 90 days by default.                                                          | Needed to justify old recommendations without re-fetching from the source.                    | Per-source TTL.                                                            |
| Full prompts sent to ACP targets                                                | 30 days by default.                                                          | Needed to debug recommendation quality and reproduce schema failures.                         | Global TTL; future per-plugin TTLs can allow `never` for sensitive scopes. |
| Agent reasoning or intermediate stream text                                     | Do not persist by default.                                                   | Usually not required for product behavior and may contain sensitive derived content.          | Optional debug logging with explicit opt-in.                               |
| Recommendation summaries, options, evidence refs, approvals, and action results | Keep.                                                                        | Core product history and audit trail.                                                         | Export/delete plugin; future audit compaction.                             |
| Draft action payloads                                                           | Keep while recommendation is active; keep approved edited payloads in audit. | Needed for approval and audit.                                                                | Per-source TTL for inactive drafts.                                        |
| Attachments and large source blobs                                              | 7 days or no local copy when plugin can re-fetch cheaply.                    | Useful for immediate triage but high privacy and storage risk.                                | Per-source TTL and max-size limits.                                        |

SQLite encryption is not required for MVP by default.
Adding it usually means choosing and shipping SQLCipher or an equivalent encrypted SQLite build, managing passphrases or OS keychain integration, handling migrations and backups differently, and debugging more platform-specific installation failures.
The MVP should document that local data is stored in the user's filesystem under `~/.firstpass`, recommend full-disk encryption for sensitive machines, and leave database encryption as a later opt-in feature unless Gmail or enterprise use makes it a hard requirement.

Backup and portability should start with local export/import, not hosted backup.
V1 should provide an explicit export of local state, installed plugin identities, and redacted core configuration.
Exporting plugin configuration, retention policies, and audit history should be treated as future portability work.
Hosted backup can come later as an optional encrypted convenience layer and must not become required for normal local operation.

Polling is the only required sync mechanism through MVP and V1.
An optional webhook bridge can be added later for sources that support near-realtime delivery, but plugins must continue to work correctly with polling and fingerprints.

Shared team inboxes are out of scope for this product surface until the single-user approval and audit loop is proven.
Team usage introduces assignment, shared policy, delegated approvals, shared credentials, multi-user audit, and conflict resolution.
Those requirements should be treated as a later product or a major mode, not a small extension of MVP.

Core status includes agent target and source, installed plugin sync health, item counts by local state, queue counts, and event count.

Users should be able to inspect one recommendation and see the exact prompt context summary, action schemas, ACP target, model when reported, token usage, and plugin validation warnings.

## Key Design Decisions

| Decision                                                                           | Rationale                                                                                                                               | Cost                                                                                                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Plugin CLI instead of in-process SDK.                                              | Executable plugins with JSON stdin/stdout are language-agnostic, agent-friendly, easy to test, and isolated at the process boundary.    | Process startup overhead and stricter protocol design burden.                                                             |
| ACP runtime instead of native agent adapters.                                      | `acpx/runtime` gives one agent integration boundary, persistent sessions, registry overrides, streaming events, and target flexibility. | Agent target behavior depends on ACP adapter quality and users must understand where prompt data is sent.                 |
| Local watermarks instead of remote tracking.                                       | Activity watermarks and content fingerprints avoid assuming labels, tags, unread state, or custom fields across sources.                | Local state must be backed up if the user cares about durable history.                                                    |
| Plugin-defined actions instead of core state changes.                              | Plugin action payloads avoid hard-coded GitHub-like enums and let new sources add actions without core changes.                         | More validation complexity and less uniform UI unless action rendering is carefully designed.                             |
| Explicit approval for all remote writes in MVP.                                    | Matches the trust posture and avoids accidental public or private communication mistakes.                                               | Per-action automation policies wait until audit and preview systems are proven.                                           |
| Document plugin credential risk instead of requiring split read/write credentials. | A single credential setup keeps source onboarding practical while still educating users about scopes and trust.                         | A malicious plugin can misuse any granted write scopes outside the intended approval flow.                                |
| Retention controls in MVP, database encryption later.                              | TTLs reduce data hoarding with less platform complexity than encrypted SQLite.                                                          | Users who need encrypted local state must rely on full-disk encryption or wait for an opt-in database encryption feature. |

## Risks And Mitigations

| Risk                                                                                 | Mitigation                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin action schemas may become too expressive and hard for agents to use reliably. | Keep action schemas small and provide plugin examples.                                                                                                            |
| Local-only tracking may annoy users who expect handled state across machines.        | Provide export and backup before cross-device sync.                                                                                                               |
| Email privacy expectations are much higher than GitHub issue privacy.                | Add context retention settings from the beginning and prefer drafts over sends.                                                                                   |
| X API access may be too expensive or unstable for a first-party plugin.              | Support read-only mode and treat X as V1 only if viable.                                                                                                          |
| Source rate limits may make frequent polling impractical.                            | Prefer plugin-rendered prompt context over raw full history; keep polling as the required sync path and add an optional webhook bridge later.                     |
| Plugin security is weaker than a sandboxed permission model.                         | Persist manifest metadata, document credential risks clearly, install only trusted plugins, and explore sandboxing, signed plugins, and permission prompts later. |
| Prompt context can become too large for long email threads or large PRs.             | Prefer plugin-rendered prompt context over raw full history.                                                                                                      |
| Prompt context can leave the machine through hosted ACP targets.                     | Show ACP target disclosure during setup, persist prompt retention controls, and recommend local ACP targets or no triage for sensitive plugin scopes.             |
| Cross-source prioritization may require user-specific policy that is hard to infer.  | Keep MVP sorting simple and deterministic: plugin urgency hint, snooze expiry, recency, then configured-plugin order.                                             |
| Public writes and destructive actions have high reputation or durability risk.       | Treat them as high-friction approvals.                                                                                                                            |
| First-party plugin behavior may drift from the protocol.                             | Use recorded fixtures and strict contract tests.                                                                                                                  |

## Testing Strategy

Most coverage should come from e2e tests that run the real built CLI against temporary state directories, a mocked ACP target, and mocked source plugin executables.
Unit tests are still useful, but mostly for pure functions, schema helpers, state reducers, redaction, and small validation utilities.
No default test requires live network access.

E2e tests should cover:

- First-run init, config loading, bundled plugin listing, manifest validation, and immediate plugin installation.
- Daemon sync from a mocked source plugin into a real temporary SQLite database.
- Sync idempotency with repeated fingerprints, duplicate events, pagination, `rate_limited`, `permission_denied`, `error`, deletions, and partial responses.
- ACP recommendation generation through a mocked ACP target using the same `acpx/runtime` path as production.
- Recommendation validation, evidence reference validation, invalid agent output, schema repair or error surfacing, raw ACP command redaction, cancellation, and usage estimation fallback.
- Full review lifecycle: list, detail, approve, edit, dismiss, snooze, rerun, open-source-item, mark handled, and copy handoff prompt.
- Approval execution with mocked plugin `validate-action`, `preview-action`, and `execute-action`, including partial failure, dependencies, optional action failure, required action failure, and idempotency retry.
- Item state transitions for retriage, dismissal, snooze expiry, action errors, ignored items, and newer activity watermarks.
- Prompt-context retention cleanup, with broader raw context, draft, attachment, and audit cleanup covered as future retention work.
- CLI output contracts for scriptable commands, including empty states and structured errors.
- TUI smoke tests for launch, keyboard navigation, resize handling, and core review actions against fixture data.

Smaller test layers:

- Pure unit tests for state eligibility, sorting, retention TTL calculation, redaction, config normalization, and schema helpers.
- Behavior assertions for prompt assembly and human-visible action previews instead of golden snapshot files.
- First-party plugin contract tests against recorded source fixtures, still offline by default.

Avoid golden tests during early iteration because prompts, previews, and terminal copy will change often by design.

## Implementation Plan

Completed items should be checked off in this document as implementation PRs merge.

Phase 0: Project skeleton and protocol proof

- [x] Create the Node ESM JavaScript package with Commander, `tsc --noEmit`, Vitest, linting, formatting, and build scripts.
- [x] Add config loading for `~/.firstpass/config.yaml`, state directory creation, and snake_case config validation.
- [x] Add the SQLite connection, migration runner, and initial schema for plugins, configured plugins, items, events, and fingerprints.
- [x] Define runtime validators for plugin manifests, sync responses, fetch responses, recommendations, and action results.
- [x] Build the mock source plugin executable with manifest, configure, sync, fetch, validate-action, preview-action, execute-action, automation-workspace, and PR-detection commands.
- [x] Add e2e harness utilities for temporary state directories, mocked source plugins, mocked ACP targets, and built CLI execution.
- [x] Implement `firstpass init`, `firstpass status`, `firstpass plugin list`, and `firstpass plugin list` against real local state.
- [x] Implement one e2e test that syncs mock plugin items into SQLite through the real CLI.

Phase 1: Core inbox loop

- [x] Implement bundled plugin listing and immediate installation for known plugin IDs.
- [x] Implement manifest validation, manifest metadata persistence, and immediate installation for configured plugins.
- [x] Implement `firstpass plugin configure` and `firstpass plugin doctor` for the mock plugin.
- [x] Implement the daemon sync loop with fingerprint persistence, pagination, rate-limit, permission-denied, error, deletion, and partial-response handling.
- [x] Implement item eligibility, local watermarks, simple attention policy, deterministic sorting, and item state transitions.
- [x] Implement `firstpass list` and `firstpass view <item-id>` with compact structured output and definitive empty states.
- [x] Implement ACP recommendation generation through `acpx/runtime` using a mocked ACP target in e2e tests.
- [x] Implement recommendation validation, evidence validation, action payload validation, invalid-output handling, and usage estimation fallback.
- [x] Implement rerun triage with private user instructions and persisted agent run records.

Phase 2: Approval and review UX

- [x] Implement local dismiss, snooze, mark-handled, open-source-item, and copy-handoff flows through CLI commands.
- [x] Implement approval intent persistence, pre-execution validation, action previews, sequential execution, and action result records.
- [x] Implement multi-action approval behavior for dependencies, optional failures, required failures, and idempotency retries.
- [x] Implement the first Ink TUI shell with queue pane, detail pane, action pane, status bar, keyboard navigation, and fixture-backed launch tests.
- [x] Implement TUI flows for view, approve, edit, dismiss, snooze, rerun, open, and mark handled against local state.
- [x] Apply the initial RICEd visual theme with source badges, confidence pills, safety badges, evidence cards, and action preview styling.
- [x] Add TUI smoke tests for launch, navigation, resize handling, and core review actions.

Phase 3: First-party GitHub plugin

- [x] Implement GitHub plugin configuration using existing credentials or OS credential storage without writing secrets to core config.
- [x] Implement GitHub manifest, trust metadata, item types, action types, action schemas, safety levels, and prompt examples.
- [x] Implement GitHub sync for issues, pull requests, review threads, comments, reviews, labels, state changes, fingerprints, and rate limits.
- [x] Implement GitHub fetch context with compact human context, compact agent context, evidence references, source URLs, and code-related metadata.
- [x] Implement GitHub action validation and previews for comments, labels, close, reopen, review actions, and safe PR actions.
- [x] Implement GitHub action execution with approval IDs, idempotency keys, natural-key checks, and recorded source fixtures.
- [x] Add offline GitHub plugin contract tests using recorded fixtures and no default live network access.
- [x] Run the full e2e review lifecycle against recorded GitHub fixtures through the real CLI and daemon.

Phase 4: Trust, privacy, and retention

- [x] Seed retention policy defaults and implement prompt-context TTL cleanup.
- [ ] Implement retention cleanup for raw context, rendered context, drafts, attachments, and audit policy controls.
- [x] Add ACP target disclosure and hosted-model warning copy.
- [x] Add raw ACP command redaction helper for logs and user-facing errors; status and export hardening remains future work.
- [x] Persist plugin manifest metadata for publisher, version, requested scopes, capabilities, and action catalog metadata.
- [x] Add user-facing plugin author documentation for manifests, protocol commands, trust metadata, scopes, and safety levels.
- [x] Add export/import for installed plugin identities and redacted core configuration.

Phase 5: Gmail and broader source proof after MVP

- [ ] Harden Gmail plugin configuration with production credential guidance and no secrets in core config.
- [ ] Harden Gmail manifest, thread item type, draft-first actions, archive/read/label actions, and email-specific safety warnings.
- [ ] Harden Gmail sync, fetch context, evidence references, retention defaults, and attachment metadata handling.
- [ ] Harden Gmail action validation, previews, draft creation, archive/read/label execution, and offline recorded fixture tests.
- [ ] Run the full e2e lifecycle across mock, GitHub, and production Gmail to validate the broader source abstraction.

Phase 6: Polish and release readiness

- [x] Add approval receipts and action audit export.
- [x] Add daemon status with agent target/source, plugin sync health, item counts, queue counts, and event count.
- [x] Harden CLI structured output, errors, no-op mutation behavior, truncation, and contextual help for agent use.
- [x] Improve TUI visual polish, empty states, loading states, error states, and screenshot-ready demo fixtures.
- [x] Add package publishing checks for `npm install -g firstpass` on supported Node and OS targets.
- [x] Add release documentation covering install, setup, plugin trust, credentials, retention, ACP targets, and first GitHub workflow.
