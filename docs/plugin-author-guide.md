# FirstPass Plugin Author Guide

FirstPass source plugins are ordinary executables that speak a small JSON protocol over stdin and stdout.
The core owns local storage, triage lifecycle, approval, and audit.
Plugins own source-specific authentication, sync semantics, context rendering, action validation, previews, execution, and source URLs.

## Executable Contract

Plugin executables should be named `firstpass-src-<source>`.
Every command accepts one JSON object on stdin and writes one JSON object on stdout.
Diagnostic logs may go to stderr, but user-facing bug reports can redact stderr by default, so protocol failures should be represented in stdout when possible.
The core passes `--protocol-version firstpass.plugin.v1` to plugin commands.
Exit code `0` means the command returned a protocol-level response, including application statuses such as `permission_denied`.
Nonzero exit codes are treated as transport or plugin process failures.

Supported commands are:

| Command           | Purpose                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `manifest`        | Return source identity, trust metadata, requested scopes, capabilities, item types, and action catalog. |
| `doctor`          | Report local readiness checks and warnings.                                                             |
| `configure`       | Resolve source credentials and return the plugin's derived display name.                                |
| `sync`            | Return changed items, recent events, deletion markers, cursor progress, and sync status.                |
| `fetch`           | Return full human and agent context plus evidence references for one item.                              |
| `render`          | Return compact Markdown context for human item detail views.                                            |
| `validate-action` | Check whether a proposed action payload is well formed, permitted, and still applicable.                |
| `preview-action`  | Return the human-readable effect of a proposed action before approval.                                  |
| `execute-action`  | Execute one approved action with an approval id and idempotency key.                                    |
| `open-url`        | Return the native source URL for one item.                                                              |

## Manifest

The manifest is the trust and capability boundary between core and plugin.
Keep it accurate because FirstPass stores it, shows it during trust prompts, and uses it to validate recommendations.

Required top-level fields are:

| Field              | Meaning                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `protocol_version` | The protocol version returned by the plugin, currently `firstpass.plugin.v1`. |
| `plugin`           | Object with `id`, `name`, and `version`.                                      |
| `publisher`        | Object with `name` and optional `homepage_url`.                               |
| `trust`            | Distribution and provenance metadata.                                         |
| `requested_scopes` | Array of source credential scopes and human-readable purposes.                |
| `capabilities`     | Boolean support flags for protocol commands.                                  |
| `item_types`       | Source item type ids and display names.                                       |
| `action_types`     | Action catalog available to agent recommendations and approval flows.         |

Example:

```json
{
  "protocol_version": "firstpass.plugin.v1",
  "plugin": { "id": "tickets", "name": "Tickets", "version": "1.0.0" },
  "publisher": {
    "name": "Example Inc.",
    "homepage_url": "https://example.com"
  },
  "trust": {
    "third_party": true,
    "distribution": "npm",
    "package": "firstpass-src-tickets"
  },
  "requested_scopes": [
    {
      "scope": "tickets:read",
      "purpose": "Read tickets, comments, and status changes that may need attention."
    },
    {
      "scope": "tickets:write",
      "purpose": "Create approved replies or private notes after explicit user approval."
    }
  ],
  "capabilities": {
    "sync": true,
    "fetch_context": true,
    "render_context": true,
    "validate_action": true,
    "preview_action": true,
    "execute_action": true,
    "open_url": true
  },
  "item_types": [{ "type": "ticket", "display_name": "Ticket" }],
  "action_types": [
    {
      "type": "reply",
      "display_name": "Reply",
      "description": "Post a visible reply on a ticket.",
      "safety": "external_write",
      "idempotency": "client_token",
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["body"],
        "properties": { "body": { "type": "string" } }
      },
      "prompt_examples": ["Reply with a concise acknowledgement and next step."]
    }
  ]
}
```

## Trust Metadata And Scopes

Plugin code is not a sandbox boundary.
A plugin can use any credentials it can access, including outside commands that are nominally read-only.
The approval boundary protects users from agent-selected actions executed by honest plugins, not from malicious plugin code.

Use `trust` to make provenance clear.
First-party bundled plugins can use metadata such as `{ "first_party": true, "bundled": true }`.
Third-party plugins should include the package manager, package name, explicit binary path, repository URL, or other install source that helps a user decide whether to trust the executable.

Use `requested_scopes` to disclose every source credential scope the plugin expects.
Prefer the narrowest practical credential guidance.
If writes are optional, document how users can configure read-only credentials and what capabilities will be unavailable.
Never store secrets in FirstPass core config unless a source makes that unavoidable.
Prefer source CLIs, OS keychain storage, OAuth token stores, or plugin-owned encrypted files.

FirstPass detects material manifest trust changes such as binary path, publisher, version, requested scopes, capabilities, and action catalog changes.
Users can be asked to re-confirm trust when those change.

## Sync Semantics

`sync` input includes the plugin's scope `config`, prior `cursor`, `limit`, and `mode` as `incremental` or `full`.
There is no `account_id`: a configured plugin is the unit, so the core passes the plugin's own `config` object and treats it as opaque.
If a plugin needs to represent more than one identity (for example two GitHub logins), it does so inside its own `config` and must keep its `external_id`s unique across those identities.
The cursor is plugin-owned and can be any JSON value.
The core saves the returned cursor only after items, events, deletion markers, and warnings are durably persisted.

`sync` status values are:

| Status              | Meaning                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `complete`          | The returned cursor covers all known source activity for the request window.                           |
| `partial`           | The core should persist the response, save the cursor, and immediately sync again.                     |
| `rate_limited`      | The core should persist returned data and wait at least `retry_after_seconds` before retrying.         |
| `cursor_invalid`    | The plugin cannot safely continue from the prior cursor and the core should rerun with `mode: "full"`. |
| `permission_denied` | Credentials are missing or insufficient and the plugin should be marked unhealthy.                     |

Items should use stable `external_id` values and source-owned activity watermarks.
Events should use stable `external_id` values that can be inserted idempotently.
Deletion markers belong in `deleted_item_external_ids` and should use the same external ids as prior items.
Repeated sync calls may return duplicate items or events if that is the safest source behavior.

## Context And Evidence

`fetch` returns the context used for triage.
Separate compact human context from agent context so the UI can stay readable while the prompt has enough detail.
Evidence ids should be stable inside one fetched context and should point at events, snippets, attachments, related objects, source URLs, or local files.
Recommendations cite evidence ids rather than embedding source text repeatedly.

`render` returns Markdown for the detail view.
Keep it concise and avoid leaking secrets that are not needed for human review.

## Actions And Safety Levels

Each action type declares a strict JSON Schema, safety level, idempotency behavior, and prompt examples.
Small action schemas are easier for agents to use and easier for users to review.

Safety levels are:

| Safety           | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `local_only`     | Changes only local FirstPass state.                                          |
| `source_private` | Changes private source state such as archive, read state, labels, or drafts. |
| `external_write` | Sends text or visible interaction to other people.                           |
| `destructive`    | Closes, deletes, blocks, merges, or otherwise changes durable shared state.  |

The core passes the plugin's scope `config` (never an `account_id`) to `fetch`, `render`, `open-url`, `validate-action`, `preview-action`, `execute-action`, and the automation-workspace commands; plugins that only need the external tool's own auth may ignore it.
`validate-action` must reject malformed payloads and should warn when source state changed since recommendation time.
`preview-action` should show the exact outgoing text or source effect before approval.
`execute-action` receives an `approval_id` and `idempotency_key` and should return `succeeded`, `failed`, or `already_applied`.
Use the idempotency key whenever the source supports client tokens.
When the source does not support client tokens, use natural keys or other best-effort checks and document that behavior in `idempotency`.

## Authoring Checklist

- Use `firstpass-src-<source>` as the executable name.
- Validate `--protocol-version firstpass.plugin.v1` before processing commands.
- Keep stdout as exactly one JSON protocol object per command.
- Keep action schemas small and strict with `additionalProperties: false` when possible.
- Return stable item ids, event ids, evidence ids, and source URLs.
- Treat cursors as opaque plugin-owned state and make sync idempotent.
- Disclose all credential scopes and trust metadata before users trust the plugin at `plugin add`.
- Prefer drafts or private source state over visible sends when the source supports it.
- Validate and preview every remote action immediately before execution.
- Avoid logging secrets to stderr because users may still choose to share raw plugin logs.
