# FirstPass Plugin Author Guide

FirstPass source plugins are ordinary executables that speak a small JSON protocol over stdin and stdout.
The core owns local storage, triage lifecycle, approval, and audit.
Plugins own source-specific authentication, sync semantics, fetched context, action validation, previews, execution, and source URLs.

## Executable Contract

Plugin executables should be named `firstpass-src-<source>`.
Every command accepts one JSON object on stdin and writes one JSON object on stdout.
Diagnostic logs may go to stderr, but user-facing bug reports can redact stderr by default, so protocol failures should be represented in stdout when possible.
The core passes `--protocol-version firstpass.plugin.v2` to plugin commands.
Exit code `0` means the command returned a protocol-level response, including application statuses such as `permission_denied`.
Nonzero exit codes are treated as transport or plugin process failures.

Supported commands are:

| Command                        | Purpose                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `manifest`                     | Return source identity, capabilities, item types, and action catalog.                       |
| `doctor`                       | Report local readiness checks and warnings.                                                 |
| `configure`                    | Resolve source credentials and return the plugin's derived display name.                    |
| `sync`                         | Return recent item events, fingerprint progress, and sync status.                           |
| `fetch`                        | Return full human and agent context plus evidence references for one item.                  |
| `validate-action`              | Check whether a proposed action payload is well formed, permitted, and still applicable.    |
| `preview-action`               | Return the human-readable effect of a proposed action before approval.                      |
| `execute-action`               | Execute one approved action with an approval id and idempotency key.                        |
| `prepare-automation-workspace` | Prepare a source-owned workspace for an approved automation job.                            |
| `submit-automation-workspace`  | Submit workspace changes for an approved automation job.                                    |
| `detect-automation-pr`         | Re-detect a pull request for a submitted automation job when initial detection was delayed. |

## Manifest

The manifest is the provenance and capability boundary between core and plugin.
Keep it accurate because FirstPass stores it and uses it to validate recommendations.

Protocol-required top-level fields are:

| Field              | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `protocol_version` | The protocol version returned by the plugin, currently `firstpass.plugin.v2`.   |
| `plugin`           | Object with `id`, `version`, optional `display_name`, and optional `publisher`. |

Recommended top-level metadata fields are:

| Field          | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| `capabilities` | Array of declared capability metadata.                                |
| `item_types`   | Source item type ids and display names.                               |
| `action_types` | Action catalog available to agent recommendations and approval flows. |

Example:

```json
{
  "protocol_version": "firstpass.plugin.v2",
  "plugin": {
    "id": "tickets",
    "version": "1.0.0",
    "display_name": "Tickets",
    "publisher": "Example Inc."
  },
  "capabilities": ["sync", "fetch", "actions", "automation"],
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

## Plugin Trust And Scopes

Plugin code is not a sandbox boundary.
A plugin can use any credentials it can access, including outside commands that are nominally read-only.
The approval boundary protects users from agent-selected actions executed by honest plugins, not from malicious plugin code.

Document provenance clearly outside the manifest.
Third-party plugins should document the package manager, package name, explicit binary path, repository URL, or other install source that helps a user decide whether to trust the executable.

Disclose every source credential scope the plugin expects in setup documentation.
Prefer the narrowest practical credential guidance.
If writes are optional, document how users can configure read-only credentials and what capabilities will be unavailable.
Never store secrets in FirstPass core config unless a source makes that unavoidable.
Prefer source CLIs, OS keychain storage, OAuth token stores, or plugin-owned encrypted files.

Keep capabilities and the action catalog current so the manifest accurately describes what the plugin can do.

## Sync Semantics

`sync` input includes the plugin's scope `config` and prior `fingerprints`.
There is no `account_id`: a configured plugin is the unit, so the core passes the plugin's own `config` object and treats it as opaque.
If a plugin needs to represent more than one identity (for example two GitHub logins), it does so inside its own `config` and must keep its `external_id`s unique across those identities.
Fingerprints are plugin-owned and can be any JSON object.
The core saves returned fingerprints only after events and warnings are durably persisted.

`sync` status values are:

| Status              | Meaning                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `complete`          | The returned fingerprints cover all known source activity for the request window.                    |
| `partial`           | The core should persist the response, save fingerprints, and immediately sync again.                 |
| `rate_limited`      | The core should persist returned data and retry after `retry_after_seconds`, capped by core backoff. |
| `permission_denied` | Credentials are missing or insufficient; the core records the warning and retries after backoff.     |
| `error`             | Sync failed; the core records the warning and retries after backoff.                                 |

Events should use stable `external_id` values that can be inserted idempotently.
Item events should include source-owned activity watermarks and payloads with enough detail for core projections.
Item event `metadata` may include a short `display_handle` for inbox rows, such as `owner/repo · PR #123` or `sender · subject`.
If omitted, the TUI falls back to the humanized `item_type`.
Deletion or unavailable-item changes should be represented as events with the same external ids as prior items.
Repeated sync calls may return duplicate events if that is the safest source behavior.

## Context And Evidence

`fetch` returns the context used for triage.
Separate compact human context from agent context so the UI can stay readable while the prompt has enough detail.
Evidence ids should be stable inside one fetched context and should point at events, snippets, attachments, related objects, source URLs, or local files.
Recommendations cite evidence ids rather than embedding source text repeatedly.

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

The core passes the plugin's scope `config` (never an `account_id`) to `fetch`, `validate-action`, `preview-action`, `execute-action`, and the automation-workspace commands; plugins that only need the external tool's own auth may ignore it.
`validate-action` must reject malformed payloads and should warn when source state changed since recommendation time.
`preview-action` should show the exact outgoing text or source effect before approval.
The TUI also builds a pre-approval WILL DO summary from action params; use plain visible payload names such as `body`, `text`, `message`, `comment`, or `labels` so users can review the selected option clearly.
`execute-action` receives an `approval_id` and `idempotency_key` and should return `succeeded`, `failed`, or `already_applied`.
Use the idempotency key whenever the source supports client tokens.
When the source does not support client tokens, use natural keys or other best-effort checks and document that behavior in `idempotency`.

## Authoring Checklist

- Use `firstpass-src-<source>` as the executable name.
- Validate `--protocol-version firstpass.plugin.v2` before processing commands.
- Keep stdout as exactly one JSON protocol object per command.
- Keep action schemas small and strict with `additionalProperties: false` when possible.
- Return stable item ids, event ids, evidence ids, and source URLs.
- Treat fingerprints as opaque plugin-owned state and make sync idempotent.
- Put the most actionable sync warning first because FirstPass stores it as the plugin status error; include detailed diagnostics in later warnings for daemon logs.
- Disclose all credential scopes and provenance accurately in setup documentation.
- Prefer drafts or private source state over visible sends when the source supports it.
- Validate and preview every remote action immediately before execution.
- Avoid logging secrets to stderr because users may still choose to share raw plugin logs.
