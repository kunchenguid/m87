#!/usr/bin/env node
// FirstPass Gmail source plugin - contract v2 (emit-only-events).
//
// `sync` is a pure diff: given the fingerprint baseline core hands back, it
// emits item events (created/updated/closed) for whatever changed and returns
// the new baseline. Core folds the events; the plugin keeps no database.
//
// DEMO ONLY: this plugin serves recorded Gmail thread fixtures and does not
// send live writes. Live mailbox reads/writes require Gmail OAuth credentials
// in GOOGLE_APPLICATION_CREDENTIALS or the OS credential store; FirstPass core
// config stores no Gmail secrets. Action execution records offline fixtures
// rather than calling the Gmail API.

const PROTOCOL_VERSION = "firstpass.plugin.v2";

const SUPPORTED_PROTOCOL_VERSION = PROTOCOL_VERSION;
const protocolVersionArgIndex = process.argv.indexOf("--protocol-version");
if (protocolVersionArgIndex !== -1) {
  const requested = process.argv[protocolVersionArgIndex + 1] ?? "";
  if (requested !== SUPPORTED_PROTOCOL_VERSION) {
    process.stderr.write(
      `unsupported protocol version: ${requested}; expected ${SUPPORTED_PROTOCOL_VERSION}\n`,
    );
    process.exit(1);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

const getCredentialSource = () =>
  typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === "string" &&
  process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0
    ? "GOOGLE_APPLICATION_CREDENTIALS"
    : null;

const getGmailThreadUrl = (itemExternalId) => {
  const threadId = itemExternalId.startsWith("gmail:thread:")
    ? itemExternalId.slice("gmail:thread:".length)
    : itemExternalId;
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
};

const MANIFEST = {
  protocol_version: PROTOCOL_VERSION,
  plugin: {
    id: "gmail",
    version: "2.0.0",
    display_name: "Gmail",
    publisher: "firstpass",
  },
  trust: {
    first_party: true,
    bundled: true,
    network: ["none"],
    writes: ["gmail"],
  },
  requested_scopes: [
    {
      scope: "gmail.modify",
      purpose:
        "Read and modify selected Gmail threads for review-queue triage without storing OAuth secrets in FirstPass config.",
    },
    {
      scope: "gmail.compose",
      purpose:
        "Create draft replies only after explicit user approval; sending mail is intentionally out of scope.",
    },
  ],
  capabilities: ["sync", "fetch", "actions"],
  item_types: [{ type: "email_thread", display_name: "Email Thread" }],
  action_types: [
    {
      type: "draft_reply",
      display_name: "Draft Reply",
      description:
        "Create a Gmail draft reply for the thread after explicit approval; sending remains manual.",
      safety: "external_write",
      idempotency: "client_token",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: {
          body: { type: "string" },
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          bcc: { type: "array", items: { type: "string" } },
        },
      },
      prompt_examples: [
        "Draft a concise reply that cites the email evidence without sending it.",
      ],
    },
    {
      type: "archive",
      display_name: "Archive Thread",
      description: "Archive a Gmail thread after explicit approval.",
      safety: "source_private",
      idempotency: "natural_key",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string" } },
      },
      prompt_examples: [
        "Archive noisy threads only when the evidence shows no user action is needed.",
      ],
    },
    {
      type: "mark_read",
      display_name: "Mark Read",
      description: "Mark a Gmail thread as read after explicit approval.",
      safety: "source_private",
      idempotency: "natural_key",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string" } },
      },
      prompt_examples: [
        "Mark FYI-only threads as read when no follow-up is required.",
      ],
    },
    {
      type: "label",
      display_name: "Apply Label",
      description: "Apply one or more Gmail labels after explicit approval.",
      safety: "source_private",
      idempotency: "natural_key",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["labels"],
        properties: {
          labels: { type: "array", items: { type: "string" } },
        },
      },
      prompt_examples: [
        "Apply a follow-up label when the thread needs a later response.",
      ],
    },
  ],
};

// The "live source" the plugin reflects. This is a recorded offline fixture;
// no live mailbox data is read. Config may override `threads` for tests.
function sourceThreads(config) {
  if (Array.isArray(config?.threads)) {
    return config.threads;
  }
  return [
    {
      external_id: "gmail:thread:thread-1",
      item_type: "email_thread",
      title: "Re: FirstPass Gmail integration follow-up",
      actor: "alice@example.com",
      state: "unread",
      url: getGmailThreadUrl("gmail:thread:thread-1"),
      activity_at: "2026-02-03T04:05:06.000Z",
      activity_id: "gmail-thread-1-message-1",
      fingerprint: "gmail-thread-1-v1",
      attention: {
        should_surface: true,
        reason: "Alice asked for a follow-up on the Gmail integration plan.",
        waiting_on: "user",
        priority_hint: "normal",
      },
      payload: {
        type: "thread_received",
        thread_id: "thread-1",
        message_id: "message-1",
        labels: ["INBOX", "UNREAD"],
        attachment_count: 1,
      },
    },
  ];
}

// Pure diff against the fingerprint baseline core hands back. Emits only events
// and returns the new complete fingerprint map. Mirrors the mock plugin.
function diff(config, fingerprints) {
  const events = [];
  const next = {};
  const threads = sourceThreads(config);
  for (const thread of threads) {
    next[thread.external_id] = thread.fingerprint;
    const prior = fingerprints?.[thread.external_id];
    if (prior === undefined) {
      events.push({ ...thread, lifecycle: "created" });
    } else if (prior !== thread.fingerprint) {
      events.push({
        ...thread,
        lifecycle: "updated",
        payload: { ...thread.payload, local_state: "new" },
      });
    }
  }
  // threads that disappeared from the source are closed
  for (const externalId of Object.keys(fingerprints ?? {})) {
    if (!(externalId in next)) {
      events.push({
        external_id: externalId,
        lifecycle: "closed",
        state: "closed",
        fingerprint: "closed",
        payload: { type: "thread_closed" },
      });
    }
  }
  return { events, fingerprints: next };
}

const getActionInput = (input) => {
  const itemExternalId =
    typeof Reflect.get(input, "item_external_id") === "string" &&
    Reflect.get(input, "item_external_id").trim().length > 0
      ? Reflect.get(input, "item_external_id")
      : "gmail:thread:unknown";
  const action = Reflect.get(input, "action");
  const actionObject =
    action !== null && typeof action === "object" && !Array.isArray(action)
      ? action
      : {};
  const actionId =
    typeof Reflect.get(actionObject, "id") === "string" &&
    Reflect.get(actionObject, "id").trim().length > 0
      ? Reflect.get(actionObject, "id")
      : "gmail-action-1";
  const actionType =
    typeof Reflect.get(actionObject, "action_type") === "string" &&
    Reflect.get(actionObject, "action_type").trim().length > 0
      ? Reflect.get(actionObject, "action_type")
      : "draft_reply";
  const params = Reflect.get(actionObject, "params");
  const paramsObject =
    params !== null && typeof params === "object" && !Array.isArray(params)
      ? params
      : {};
  return { itemExternalId, actionId, actionType, paramsObject };
};

const getActionSafety = (actionType) =>
  actionType === "draft_reply" ? "external_write" : "source_private";

const getStringParam = (params, key) =>
  typeof Reflect.get(params, key) === "string" ? Reflect.get(params, key) : "";

const getStringArrayParam = (params, key) =>
  Array.isArray(Reflect.get(params, key))
    ? Reflect.get(params, key).filter((value) => typeof value === "string")
    : [];

const getRecipientDomains = (recipients) =>
  Array.from(
    new Set(
      recipients
        .map((recipient) => recipient.split("@")[1] ?? "")
        .filter((domain) =>
          domain.length > 0 && domain !== "example.com" ? true : false,
        ),
    ),
  );

const getGmailWarnings = (actionType, params) => {
  if (actionType === "draft_reply") {
    const recipients = [
      ...getStringArrayParam(params, "to"),
      ...getStringArrayParam(params, "cc"),
      ...getStringArrayParam(params, "bcc"),
    ];
    const externalDomains = getRecipientDomains(recipients);
    return [
      "Gmail draft replies create drafts only; review recipients and body in Gmail before sending.",
      externalDomains.length > 0
        ? `Gmail draft reply includes external-domain recipients: ${externalDomains.join(", ")}.`
        : "",
    ].filter((warning) => warning.length > 0);
  }
  if (actionType === "archive") {
    return [
      "Gmail archive changes private mailbox state only; no message will be sent.",
    ];
  }
  if (actionType === "mark_read") {
    return [
      "Gmail mark-read changes private mailbox state only; no message will be sent.",
    ];
  }
  return [
    "Gmail label changes private mailbox state only; no message will be sent.",
  ];
};

const getPreviewBody = (actionType, params) => {
  const reason = getStringParam(params, "reason");
  const labels = getStringArrayParam(params, "labels");
  const body = getStringParam(params, "body");
  const recipients = getStringArrayParam(params, "to");
  if (actionType === "draft_reply") {
    return [
      recipients.length > 0
        ? `To: ${recipients.join(", ")}`
        : "To: thread recipients",
      "",
      body,
    ].join("\n");
  }
  if (actionType === "label") {
    return `Apply labels: ${labels.join(", ")}`;
  }
  if (actionType === "mark_read") {
    return [
      "Mark thread as read.",
      reason.length > 0 ? `Reason: ${reason}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
  return ["Archive thread.", reason.length > 0 ? `Reason: ${reason}` : ""]
    .filter((part) => part.length > 0)
    .join("\n\n");
};

function handleConfigure() {
  const credentialSource = getCredentialSource();
  return {
    protocol_version: PROTOCOL_VERSION,
    display_name: "Gmail Work",
    credentials_required: credentialSource === null,
    credentials:
      credentialSource === null
        ? { required: true }
        : { required: false, source: credentialSource },
    warnings:
      credentialSource === null
        ? [
            "Gmail OAuth credentials must stay in the OS credential store or GOOGLE_APPLICATION_CREDENTIALS; FirstPass core config stores no Gmail secrets.",
          ]
        : [
            "Gmail OAuth credentials were detected outside FirstPass core config; keep refresh tokens in the OS credential store or Google client tooling.",
          ],
  };
}

function handleDoctor() {
  const credentialSource = getCredentialSource();
  return {
    protocol_version: PROTOCOL_VERSION,
    status: "ok",
    checks: [
      {
        id: "gmail-credentials",
        status: credentialSource === null ? "warn" : "ok",
        message:
          credentialSource === null
            ? "Gmail OAuth credentials are not configured; sync serves recorded fixtures only and live mailbox reads are unavailable."
            : `Gmail OAuth credentials detected via ${credentialSource}.`,
      },
    ],
    warnings:
      credentialSource === null
        ? [
            "Gmail OAuth credentials are not configured; this plugin is demo only - recorded fixtures, does not send live writes.",
          ]
        : [],
  };
}

function handleSync(config, fingerprints) {
  const credentialSource = getCredentialSource();
  if (credentialSource === null) {
    return {
      protocol_version: PROTOCOL_VERSION,
      status: "permission_denied",
      events: [],
      fingerprints: fingerprints ?? {},
      has_more: false,
      warnings: [
        "Gmail OAuth credentials are not configured; sync cannot read mailbox activity yet.",
      ],
    };
  }
  const { events, fingerprints: nextFingerprints } = diff(
    config,
    fingerprints ?? {},
  );
  return {
    protocol_version: PROTOCOL_VERSION,
    status: "complete",
    events,
    fingerprints: nextFingerprints,
    has_more: false,
    warnings: [
      "Gmail sync used an offline recorded thread fixture; no live mailbox data was read.",
    ],
  };
}

function handleFetch(input) {
  const itemExternalId =
    typeof Reflect.get(input, "item_external_id") === "string" &&
    Reflect.get(input, "item_external_id").trim().length > 0
      ? Reflect.get(input, "item_external_id")
      : "gmail:thread:thread-1";
  const itemUrl = getGmailThreadUrl(itemExternalId);
  return {
    protocol_version: PROTOCOL_VERSION,
    human_context: {
      title: "Re: FirstPass Gmail integration follow-up",
      compact:
        "Alice asked for a follow-up on the Gmail integration plan and attached a short requirements note.",
      url: itemUrl,
    },
    agent_context: {
      compact:
        "Gmail thread from alice@example.com is waiting on the user to reply with next steps for the integration plan.",
      full: [
        "Mailbox: gmail/work",
        "Thread: Re: FirstPass Gmail integration follow-up",
        "From: Alice <alice@example.com>",
        "To: user@example.com",
        "Latest message: Can you send the concrete Gmail integration next steps today?",
        "Attachment: gmail-integration-notes.txt summarizes draft, archive, read, and label expectations.",
        "Recommended focus: draft a concise reply and cite the requested next-step plan.",
      ].join("\n"),
    },
    evidence: [
      {
        id: "ev-gmail-thread-1-message-1",
        kind: "email_message",
        source_ref: "gmail:event:thread-1:message-1",
        summary: "Alice asked for concrete Gmail integration next steps.",
        quote: "Can you send the concrete Gmail integration next steps today?",
        url: itemUrl,
      },
    ],
    redaction_hints: [
      "Gmail message bodies and attachment contents are private mailbox data; retain only compact evidence by default.",
    ],
  };
}

function handleValidateAction(input) {
  const { itemExternalId, actionId, actionType, paramsObject } =
    getActionInput(input);
  const body = getStringParam(paramsObject, "body");
  const labels = getStringArrayParam(paramsObject, "labels");
  const knownActionTypes = ["draft_reply", "archive", "mark_read", "label"];
  const valid =
    knownActionTypes.includes(actionType) &&
    (actionType !== "draft_reply" || body.trim().length > 0) &&
    (actionType !== "label" || labels.length > 0);
  return {
    protocol_version: PROTOCOL_VERSION,
    item_external_id: itemExternalId,
    action_id: actionId,
    action_type: actionType,
    valid,
    safety: getActionSafety(actionType),
    warnings: valid
      ? getGmailWarnings(actionType, paramsObject)
      : [`Gmail action is invalid or missing required params: ${actionType}.`],
  };
}

function handlePreviewAction(input) {
  const { itemExternalId, actionId, actionType, paramsObject } =
    getActionInput(input);
  return {
    protocol_version: PROTOCOL_VERSION,
    item_external_id: itemExternalId,
    action_id: actionId,
    action_type: actionType,
    safety: getActionSafety(actionType),
    summary: `Preview Gmail ${actionType} on ${itemExternalId}.`,
    preview: {
      content_type: "text/markdown",
      body: getPreviewBody(actionType, paramsObject),
    },
    warnings: getGmailWarnings(actionType, paramsObject),
  };
}

function handleExecuteAction(input) {
  const credentialSource = getCredentialSource();
  const { itemExternalId, actionId, actionType, paramsObject } =
    getActionInput(input);
  const approvalId =
    typeof Reflect.get(input, "approval_id") === "string"
      ? Reflect.get(input, "approval_id")
      : "approval-unknown";
  const idempotencyKey =
    typeof Reflect.get(input, "idempotency_key") === "string"
      ? Reflect.get(input, "idempotency_key")
      : `${approvalId}/${actionId}`;
  const body = getStringParam(paramsObject, "body");
  const reason = getStringParam(paramsObject, "reason");
  const recipients = [
    ...getStringArrayParam(paramsObject, "to"),
    ...getStringArrayParam(paramsObject, "cc"),
    ...getStringArrayParam(paramsObject, "bcc"),
  ];
  const labels = getStringArrayParam(paramsObject, "labels");
  const recordedDraftExecution =
    credentialSource !== null &&
    actionType === "draft_reply" &&
    body.length > 0;
  const recordedArchiveExecution =
    credentialSource !== null && actionType === "archive";
  const recordedMarkReadExecution =
    credentialSource !== null && actionType === "mark_read";
  const recordedLabelExecution =
    credentialSource !== null && actionType === "label" && labels.length > 0;
  const externalResult = { url: getGmailThreadUrl(itemExternalId) };

  if (actionType === "draft_reply" && body.length > 0) {
    Reflect.set(externalResult, "draft_body", body);
  }
  if (actionType === "draft_reply" && recipients.length > 0) {
    Reflect.set(externalResult, "draft_recipients", recipients);
  }
  if (recordedDraftExecution) {
    const draftId = idempotencyKey.replace(/[^a-zA-Z0-9]+/g, "-");
    Reflect.set(
      externalResult,
      "draft_url",
      `${getGmailThreadUrl(itemExternalId)}?compose=firstpass-${draftId}`,
    );
  }
  if (recordedArchiveExecution) {
    Reflect.set(externalResult, "archived", true);
    if (reason.length > 0) {
      Reflect.set(externalResult, "archive_reason", reason);
    }
  }
  if (recordedMarkReadExecution) {
    Reflect.set(externalResult, "marked_read", true);
    if (reason.length > 0) {
      Reflect.set(externalResult, "mark_read_reason", reason);
    }
  }
  if (recordedLabelExecution) {
    Reflect.set(externalResult, "labels_applied", labels);
  }

  const status =
    recordedDraftExecution ||
    recordedArchiveExecution ||
    recordedMarkReadExecution ||
    recordedLabelExecution
      ? "succeeded"
      : "failed";
  const auditSummary = recordedDraftExecution
    ? `Recorded Gmail draft fixture created for approval ${approvalId} using idempotency key ${idempotencyKey}.`
    : recordedArchiveExecution
      ? `Recorded Gmail archive fixture applied for approval ${approvalId} using idempotency key ${idempotencyKey}.`
      : recordedMarkReadExecution
        ? `Recorded Gmail mark-read fixture applied for approval ${approvalId} using idempotency key ${idempotencyKey}.`
        : recordedLabelExecution
          ? `Recorded Gmail label fixture applied for approval ${approvalId} using idempotency key ${idempotencyKey}.`
          : `Gmail API writes are not implemented yet; ${actionType} was not executed for approval ${approvalId}.`;
  const warnings = recordedDraftExecution
    ? [
        "Gmail API writes were not sent live; execution used an offline recorded draft fixture.",
        "Gmail draft was created only; sending remains manual in Gmail.",
      ]
    : recordedArchiveExecution
      ? [
          "Gmail API writes were not sent live; execution used an offline recorded archive fixture.",
          "Gmail archive changed private mailbox state only; no message was sent.",
        ]
      : recordedMarkReadExecution
        ? [
            "Gmail API writes were not sent live; execution used an offline recorded mark-read fixture.",
            "Gmail mark-read changed private mailbox state only; no message was sent.",
          ]
        : recordedLabelExecution
          ? [
              "Gmail API writes were not sent live; execution used an offline recorded label fixture.",
              "Gmail label changed private mailbox state only; no message was sent.",
            ]
          : [
              "Gmail API writes are not implemented yet; this execution is a placeholder failure.",
            ];

  return {
    protocol_version: PROTOCOL_VERSION,
    item_external_id: itemExternalId,
    approval_id: approvalId,
    action_id: actionId,
    action_type: actionType,
    status,
    idempotency_key: idempotencyKey,
    external_result: externalResult,
    audit_summary: auditSummary,
    warnings,
  };
}

function handle(command, input) {
  const config = input.config ?? {};
  switch (command) {
    case "manifest":
      return MANIFEST;
    case "doctor":
      return handleDoctor();
    case "configure":
      return handleConfigure();
    case "sync":
      return handleSync(config, input.fingerprints ?? {});
    case "fetch":
      return handleFetch(input);
    case "validate-action":
      return handleValidateAction(input);
    case "preview-action":
      return handlePreviewAction(input);
    case "execute-action":
      return handleExecuteAction(input);
    case "prepare-automation-workspace":
      return {
        protocol_version: PROTOCOL_VERSION,
        status: "failed",
        error: "automation_not_supported",
        warnings: [
          "Gmail plugin is demo only and does not implement automation workspaces.",
        ],
      };
    case "submit-automation-workspace":
      return {
        protocol_version: PROTOCOL_VERSION,
        status: "failed",
        error: "automation_not_supported",
        warnings: [
          "Gmail plugin is demo only and does not implement automation workspaces.",
        ],
      };
    default:
      return {
        protocol_version: PROTOCOL_VERSION,
        error: `unknown command: ${command}`,
      };
  }
}

// Commands that take no stdin payload; reading stdin for them would block
// under runners (e.g. execFile) that spawn without closing the input pipe.
const STDIN_FREE_COMMANDS = new Set(["manifest", "doctor"]);

async function main() {
  const command = process.argv[2];
  let input = {};
  if (!STDIN_FREE_COMMANDS.has(command)) {
    const raw = await readStdin();
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      process.stderr.write("invalid JSON input\n");
      process.exit(1);
    }
  }
  try {
    const result = handle(command, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}

main();
