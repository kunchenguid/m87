#!/usr/bin/env node
// FirstPass GitHub source plugin - contract v2 (emit-only-events).
//
// `sync` is a pure diff: given the fingerprint baseline core hands back, it
// lists live GitHub issues/pull requests through the `gh` CLI, computes a
// fingerprint per object, and emits item events:
//   - external_id absent from baseline       -> "created"
//   - external_id present, fingerprint moved  -> "updated" (payload.local_state="new")
//   - external_id in baseline, gone from live -> "closed"
// It returns the NEW complete fingerprint map. The plugin keeps no database;
// the host owns the baseline.
//
// Source-specific logic (gh invocations, external_id construction, error
// sanitization, rate-limit detection, action safety mappings) is preserved
// from the v1 adapter.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROTOCOL_VERSION = "firstpass.plugin.v2";

const command = process.argv[2];
const protocolVersionArgIndex = process.argv.indexOf("--protocol-version");
if (protocolVersionArgIndex !== -1) {
  const requested = process.argv[protocolVersionArgIndex + 1] ?? "";
  // The host passes the version it speaks. Accept the contract we implement;
  // ignore any other value rather than crashing.
  if (requested !== PROTOCOL_VERSION && requested !== "") {
    process.stderr.write(
      `note: requested protocol version ${requested}; this plugin speaks ${PROTOCOL_VERSION}\n`,
    );
  }
}

// --- stdio -----------------------------------------------------------------

const readStdinJson = async () => {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.trim() === "" ? {} : JSON.parse(input);
};

const emit = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

// --- gh CLI ----------------------------------------------------------------

const getGhBinary = () =>
  typeof process.env.FIRSTPASS_GH_BIN === "string" &&
  process.env.FIRSTPASS_GH_BIN.length > 0
    ? process.env.FIRSTPASS_GH_BIN
    : "gh";

const runGh = async (args, options = {}) => {
  const bin = getGhBinary();
  // A real gh is a native binary (gh / gh.exe) that execFile resolves directly.
  // A Node-script gh shim (e.g. a JS wrapper, or the test fake) can't be exec'd
  // on Windows, so run it under the current Node instead.
  const [command, commandArgs] = /\.[mc]?js$/i.test(bin)
    ? [process.execPath, [bin, ...args]]
    : [bin, args];
  const { stdout } = await execFileAsync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });

  return stdout;
};

const runGit = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    cwd,
  });

  return stdout;
};

const sanitizeGhError = (error) => {
  if (error === null || typeof error !== "object") {
    return "GitHub CLI command failed.";
  }

  const stderr = Reflect.get(error, "stderr");
  const stdout = Reflect.get(error, "stdout");
  const message = error instanceof Error ? error.message : "";
  const raw = [stderr, stdout, message]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .replace(/\/Users\/[^\s]+/g, "~")
    .trim();

  return raw.length > 0 ? raw.slice(0, 240) : "GitHub CLI command failed.";
};

const isMissingGhError = (error) =>
  error !== null &&
  typeof error === "object" &&
  (Reflect.get(error, "code") === "ENOENT" ||
    /not found|ENOENT/i.test(sanitizeGhError(error)));

const isRateLimitGhError = (error) =>
  /rate limit|secondary rate|too many requests|abuse detection/i.test(
    sanitizeGhError(error),
  );

// Pull a concrete backoff from a GitHub rate-limit error so the host can wait
// the right amount instead of a fixed guess (FU-8). Covers the common shapes:
// "Retry-After: 90", "try again in 42 seconds", "wait 60 seconds".
const parseRetryAfterSeconds = (error) => {
  const text = sanitizeGhError(error);
  const patterns = [
    /retry[-\s]after[:\s]+(\d+)/i,
    /try again in (\d+)\s*second/i,
    /wait (?:for )?(\d+)\s*second/i,
  ];
  for (const re of patterns) {
    const match = re.exec(text);
    if (match !== null) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds;
      }
    }
  }
  return null;
};

const DEFAULT_RETRY_AFTER_SECONDS = 300;

const rateLimitedResponse = (error, baseline) => {
  const retry = parseRetryAfterSeconds(error) ?? DEFAULT_RETRY_AFTER_SECONDS;
  return {
    protocol_version: PROTOCOL_VERSION,
    status: "rate_limited",
    events: [],
    fingerprints: baseline,
    has_more: false,
    retry_after_seconds: retry,
    warnings: [
      `GitHub CLI reported rate-limit pressure; retry after ${retry} seconds.`,
    ],
  };
};

// --- config helpers --------------------------------------------------------

const parseInputConfig = (input) => {
  const config = Reflect.get(input, "config");
  return config !== null && typeof config === "object" ? config : {};
};

const getConfigString = (config, key) => {
  const value = Reflect.get(config, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

const getConfigBoolean = (config, key, fallback = false) => {
  const value = Reflect.get(config, key);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value === "true";
  }
  return fallback;
};

const getConfigNumber = (config, key, fallback) => {
  const value = Reflect.get(config, key);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return fallback;
};

// Parse a duration like "365d", "720h", "30m", "45s", or a bare number (days)
// into milliseconds. Returns null when unset/unparseable. Used by FU-11/FU-12.
const parseDurationMs = (value) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value * 86400000;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+)\s*([dhms]?)$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2] === "" ? "d" : match[2];
  const multiplier =
    unit === "h"
      ? 3600000
      : unit === "m"
        ? 60000
        : unit === "s"
          ? 1000
          : 86400000;
  return amount * multiplier;
};

const getConfigStringArray = (config, key) => {
  const value = Reflect.get(config, key);
  if (Array.isArray(value)) {
    return value.filter(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    );
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
};

const hashJson = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

const parseGhJsonArray = (value) => {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
};

// --- external_id construction & parsing ------------------------------------

const githubUrlForExternalId = (externalId) => {
  const parts = externalId.split(":");
  if (parts.length === 3 && parts[0] === "github") {
    const [, itemType, itemPath] = parts;
    const [owner, repo, number] = itemPath.split("/");
    const pathType = itemType === "pr" ? "pull" : "issues";
    if (owner !== undefined && repo !== undefined && number !== undefined) {
      return `https://github.com/${owner}/${repo}/${pathType}/${number}`;
    }
  }

  return "https://github.com";
};

const parseIssueExternalId = (itemExternalId) => {
  const match = /^github:issue:([^/\s]+\/[^/\s]+)\/(\d+)$/.exec(itemExternalId);
  if (match === null) {
    return null;
  }
  return { repository: match[1], number: match[2] };
};

const parsePullRequestExternalId = (itemExternalId) => {
  const match = /^github:pr:([^/\s]+\/[^/\s]+)\/(\d+)$/.exec(itemExternalId);
  if (match === null) {
    return null;
  }
  return { repository: match[1], number: match[2] };
};

const parseReviewThreadExternalId = (itemExternalId) => {
  const match =
    /^github:review_thread:([^/\s]+\/[^/\s]+)\/(\d+)\/comments\/(\d+)$/.exec(
      itemExternalId,
    );
  if (match === null) {
    return null;
  }
  return {
    repository: match[1],
    pullRequestNumber: match[2],
    commentId: match[3],
  };
};

// --- record helpers --------------------------------------------------------

const getRecordRepository = (record, fallback) => {
  const repository = Reflect.get(record, "repository");
  if (repository !== null && typeof repository === "object") {
    const nameWithOwner = Reflect.get(repository, "nameWithOwner");
    if (typeof nameWithOwner === "string" && nameWithOwner.length > 0) {
      return nameWithOwner;
    }
  }
  if (typeof repository === "string" && repository.length > 0) {
    return repository;
  }
  return fallback;
};

const getGhActor = (record) => {
  const author = Reflect.get(record, "author");
  if (author !== null && typeof author === "object") {
    const login = Reflect.get(author, "login");
    if (typeof login === "string" && login.length > 0) {
      return login;
    }
  }
  return "unknown";
};

const getGhLabels = (record) => {
  const labels = Reflect.get(record, "labels");
  if (!Array.isArray(labels)) {
    return [];
  }
  const names = [];
  for (const label of labels) {
    if (label !== null && typeof label === "object") {
      const name = Reflect.get(label, "name");
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }
  return names;
};

// Content fingerprint (FU-5). The fingerprint answers "did something
// meaningful change?". Without probe data we key off updatedAt + comment count
// (any activity, including the viewer's own, moves it). When the deep timeline
// probe (FU-6) supplies `activity`, we key off the most recent NON-self
// activity instead, so the viewer's own comments do not trigger a re-triage.
const computeContentFingerprint = (
  record,
  itemType,
  repository,
  { activity = null, stale = false } = {},
) => {
  const number = Reflect.get(record, "number");
  const title = Reflect.get(record, "title");
  const state = Reflect.get(record, "state");
  const updatedAt = Reflect.get(record, "updatedAt");
  const normalizedState =
    typeof state === "string" ? state.toLowerCase() : "unknown";
  const base = {
    itemType,
    repository,
    number,
    title,
    state: normalizedState,
    labels: getGhLabels(record),
    reviewDecision: Reflect.get(record, "reviewDecision"),
    // Crossing the stale threshold re-surfaces the item, so it is part of the
    // fingerprint (FU-11).
    stale,
  };
  if (activity !== null && typeof activity === "object") {
    return hashJson({
      ...base,
      // Only foreign activity advances the fingerprint when probing.
      foreign_activity_at: activity.last_non_self_activity_at ?? null,
    });
  }
  return hashJson({
    ...base,
    updatedAt:
      typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
    comments: Reflect.get(record, "comments"),
  });
};

// Selective attention semantics. `role` and `activity` (FU-3) let a
// self-authored maintainer item stay out of the inbox until someone else
// engages, while contributor items (your work in others' repos) are surfaced so
// you can act on responses.
const mapGhAttention = (
  record,
  itemType,
  actor,
  username,
  { role = "maintainer", activity = null } = {},
) => {
  const state = Reflect.get(record, "state");
  const normalizedState = typeof state === "string" ? state.toLowerCase() : "";
  const reviewDecision = Reflect.get(record, "reviewDecision");
  const itemLabel = itemType === "pull_request" ? "pull request" : "issue";

  if (normalizedState === "closed" || normalizedState === "merged") {
    return {
      should_surface: false,
      reason: `GitHub ${itemLabel} is closed with no new user action required.`,
      waiting_on: "none",
      priority_hint: "normal",
    };
  }

  if (
    itemType === "pull_request" &&
    typeof username === "string" &&
    actor === username &&
    reviewDecision === "CHANGES_REQUESTED"
  ) {
    return {
      should_surface: true,
      reason:
        "GitHub pull request has requested changes for the configured user.",
      waiting_on: "user",
      priority_hint: "urgent",
    };
  }

  // Items you authored elsewhere are tracked so you can respond to others.
  if (role === "contributor") {
    return {
      should_surface: true,
      reason: `You authored this GitHub ${itemLabel}; track it for responses.`,
      waiting_on: "user",
      priority_hint: "normal",
    };
  }

  if (typeof username === "string" && actor === username) {
    // Self-authored maintainer item: surface only when the probe found activity
    // from someone else; otherwise keep it out of the inbox.
    const foreignActivityAt =
      activity !== null && typeof activity === "object"
        ? activity.last_non_self_activity_at
        : undefined;
    if (typeof foreignActivityAt === "string" && foreignActivityAt.length > 0) {
      return {
        should_surface: true,
        reason: `Another user engaged with your GitHub ${itemLabel}.`,
        waiting_on: "user",
        priority_hint: "normal",
      };
    }
    return {
      should_surface: false,
      reason: `Latest visible GitHub ${itemLabel} activity is from the configured user.`,
      waiting_on: "other",
      priority_hint: "normal",
    };
  }

  return {
    should_surface: true,
    reason: `GitHub ${itemLabel} has external activity that may need a response.`,
    waiting_on: "user",
    priority_hint: "normal",
  };
};

// Map a raw gh record into a plugin event SHELL (without lifecycle, which the
// diff assigns). payload.type encodes the source-specific fact.
// `role` is the viewer's relationship to the item ("maintainer" for configured
// or owned repos, "contributor" for items the viewer authored elsewhere). It is
// a GitHub-domain fact carried in item metadata so core stays source-agnostic.
const mapGhObject = (
  record,
  itemType,
  repository,
  username = null,
  role = "maintainer",
  { activity = null, staleThresholdMs = null } = {},
) => {
  const number = Reflect.get(record, "number");
  const title = Reflect.get(record, "title");
  const state = Reflect.get(record, "state");
  const url = Reflect.get(record, "url");
  const updatedAt = Reflect.get(record, "updatedAt");
  const actor = getGhActor(record);
  const itemKind = itemType === "pull_request" ? "pr" : "issue";
  const normalizedState =
    typeof state === "string" ? state.toLowerCase() : "unknown";
  const activityAt =
    typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString();
  const activityId = `github:${itemKind}:${repository}/${number}:${activityAt}`;
  const labels = getGhLabels(record);
  const reviewDecision = Reflect.get(record, "reviewDecision");
  const externalId = `github:${itemKind}:${repository}/${number}`;

  // Local stale marker (FU-11): an OPEN item idle longer than the threshold.
  const stale =
    normalizedState === "open" &&
    typeof staleThresholdMs === "number" &&
    Date.now() - Date.parse(activityAt) > staleThresholdMs;

  const fingerprint = computeContentFingerprint(record, itemType, repository, {
    activity,
    stale,
  });

  // Source-specific payload type. The exact label is informational; the host
  // treats payload as opaque detail.
  const payloadType =
    normalizedState === "closed" || normalizedState === "merged"
      ? itemType === "pull_request"
        ? "pr_closed"
        : "issue_closed"
      : itemType === "pull_request"
        ? reviewDecision === "CHANGES_REQUESTED"
          ? "review_requested"
          : "pr_opened"
        : "issue_opened";

  return {
    external_id: externalId,
    item_type: itemType,
    title: typeof title === "string" ? title : `GitHub ${itemKind} #${number}`,
    actor,
    state: normalizedState,
    url:
      typeof url === "string"
        ? url
        : `https://github.com/${repository}/${itemKind === "pr" ? "pull" : "issues"}/${number}`,
    activity_at: activityAt,
    activity_id: activityId,
    fingerprint,
    attention: mapGhAttention(record, itemType, actor, username, {
      role,
      activity,
    }),
    metadata: {
      role,
      author: actor,
      viewer: username,
      is_self_authored: typeof username === "string" && actor === username,
      stale,
      // Short source label for the inbox meta line. Core stays source-agnostic,
      // so the plugin names what the item is about: "owner/repo · PR/issue #n".
      display_handle: `${repository} · ${itemKind === "pr" ? "PR" : "issue"} #${number}`,
    },
    payload: {
      type: payloadType,
      repository,
      number,
      labels,
      is_draft: Reflect.get(record, "isDraft") === true,
      ...(typeof reviewDecision === "string"
        ? { review_decision: reviewDecision }
        : {}),
    },
  };
};

// WIP heuristics (FU-10): titles flagged as work-in-progress or draft.
const isWipTitle = (title) =>
  typeof title === "string" &&
  (/\bwip\b/i.test(title) || /^\s*draft\b\s*[:-]/i.test(title));

// --- repository discovery & live listing -----------------------------------

const isValidRepoName = (repo) =>
  typeof repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(repo);

// Owned, non-archived repos for the user, optionally restricted to public ones.
const listOwnedRepos = async (
  username,
  maxRepos,
  { publicOnly = false } = {},
) => {
  const records = parseGhJsonArray(
    await runGh([
      "repo",
      "list",
      username,
      "--source",
      "--limit",
      String(maxRepos),
      "--json",
      "nameWithOwner,isArchived,visibility",
    ]),
  );

  return records
    .filter((record) => record !== null && typeof record === "object")
    .filter((record) => Reflect.get(record, "isArchived") !== true)
    .filter(
      (record) =>
        !publicOnly ||
        String(Reflect.get(record, "visibility")).toUpperCase() === "PUBLIC",
    )
    .map((record) => Reflect.get(record, "nameWithOwner"))
    .filter(isValidRepoName);
};

// Repos the authenticated user has starred (full names).
const listStarredRepos = async () => {
  try {
    const output = await runGh([
      "api",
      "user/starred",
      "--paginate",
      "--jq",
      ".[].full_name",
    ]);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(isValidRepoName);
  } catch {
    return [];
  }
};

// Dynamic repo discovery conditions (FU-9), mirroring ezoss's repo_sources:
//   all_owned                      - every owned repo (any visibility)
//   all_public_owned               - public owned repos only
//   all_public_owned_and_starred   - public owned repos the user also starred
const discoverReposForCondition = async (condition, username, maxRepos) => {
  if (username === null) {
    return [];
  }
  if (condition === "all_owned") {
    return listOwnedRepos(username, maxRepos);
  }
  if (condition === "all_public_owned") {
    return listOwnedRepos(username, maxRepos, { publicOnly: true });
  }
  if (condition === "all_public_owned_and_starred") {
    const owned = new Set(
      await listOwnedRepos(username, maxRepos, { publicOnly: true }),
    );
    const starred = await listStarredRepos();
    return starred.filter((repo) => owned.has(repo));
  }
  return [];
};

// The configured discovery conditions, with the legacy `owned_repos: true`
// boolean treated as `all_owned`.
const repoConditionsFromConfig = (config) => {
  const conditions = new Set(getConfigStringArray(config, "repo_conditions"));
  if (getConfigBoolean(config, "owned_repos")) {
    conditions.add("all_owned");
  }
  return [...conditions];
};

const listLiveRepositoryObjects = async (
  repository,
  limit,
  username,
  resolveActivity = null,
  staleThresholdMs = null,
) => {
  const issueRecords = parseGhJsonArray(
    await runGh([
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--limit",
      String(limit),
      "--json",
      "number,title,author,state,url,updatedAt,labels,comments",
    ]),
  );
  const pullRequestRecords = parseGhJsonArray(
    await runGh([
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--limit",
      String(limit),
      "--json",
      "number,title,author,state,url,updatedAt,labels,reviewDecision,isDraft",
    ]),
  );

  const mapWithActivity = async (record, itemType) => {
    const state = Reflect.get(record, "state");
    const isOpen = typeof state === "string" && state.toLowerCase() === "open";
    const activity =
      resolveActivity !== null && isOpen
        ? await resolveActivity(
            itemType,
            repository,
            Reflect.get(record, "number"),
          )
        : null;
    return mapGhObject(record, itemType, repository, username, "maintainer", {
      activity,
      staleThresholdMs,
    });
  };

  const objects = [];
  for (const record of issueRecords) {
    objects.push(await mapWithActivity(record, "issue"));
  }
  for (const record of pullRequestRecords) {
    objects.push(await mapWithActivity(record, "pull_request"));
  }
  return objects;
};

const listAuthoredObjects = async (
  username,
  lookbackDays,
  staleThresholdMs = null,
) => {
  const since = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const listAuthoredFeed = async (itemKind) => {
    const records = parseGhJsonArray(
      await runGh([
        "search",
        itemKind === "issue" ? "issues" : "prs",
        "--author",
        username,
        "--updated",
        `>=${since}`,
        "--sort",
        "updated",
        "--order",
        "desc",
        "--limit",
        "100",
        "--json",
        "repository,number,title,author,state,url,updatedAt,labels",
      ]),
    );

    return records.map((record) =>
      mapGhObject(
        record,
        itemKind === "issue" ? "issue" : "pull_request",
        getRecordRepository(record, "unknown/unknown"),
        username,
        "contributor",
        { staleThresholdMs },
      ),
    );
  };

  return [
    ...(await listAuthoredFeed("issue")),
    ...(await listAuthoredFeed("pr")),
  ];
};

// Resolve the GitHub login from `gh` when config omits it. The username is not
// a credential and gh already knows it, so deriving it keeps config minimal.
const deriveGhUsername = async () => {
  try {
    const output = await runGh(["api", "user", "--jq", ".login"]);
    const login = typeof output === "string" ? output.trim() : "";
    return login.length > 0 ? login : null;
  } catch {
    return null;
  }
};

// --- deep activity probe (FU-6) --------------------------------------------
// GitHub's `updatedAt` moves on any activity, including the viewer's own. The
// probe inspects an item's comment/review timeline to find the most recent
// activity by SOMEONE ELSE, which is what should re-open a triaged item. The
// result feeds computeContentFingerprint so self-activity never re-triages.

const latestForeignActivityAt = (entries, field, viewer) => {
  let latest = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const actor = getGhActor(entry);
    if (typeof viewer === "string" && actor === viewer) {
      continue;
    }
    const at = Reflect.get(entry, field);
    if (typeof at === "string" && (latest === null || at > latest)) {
      latest = at;
    }
  }
  return latest;
};

const maxIso = (a, b) => (a === null ? b : b === null ? a : a > b ? a : b);

// Returns the ISO timestamp of the latest non-self activity, or null. Failures
// degrade to null so a probe error never blocks the sync.
const probeItemActivity = async (itemType, repository, number, viewer) => {
  try {
    if (itemType === "pull_request") {
      const record = JSON.parse(
        await runGh([
          "pr",
          "view",
          String(number),
          "--repo",
          repository,
          "--json",
          "comments,reviews",
        ]),
      );
      return maxIso(
        latestForeignActivityAt(
          Reflect.get(record, "comments"),
          "createdAt",
          viewer,
        ),
        latestForeignActivityAt(
          Reflect.get(record, "reviews"),
          "submittedAt",
          viewer,
        ),
      );
    }
    const record = JSON.parse(
      await runGh([
        "issue",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "comments",
      ]),
    );
    return latestForeignActivityAt(
      Reflect.get(record, "comments"),
      "createdAt",
      viewer,
    );
  } catch {
    return null;
  }
};

// Reserved fingerprint keys hold plugin bookkeeping (probe throttle state), not
// items. They are namespaced with "@" so they never collide with github: ids.
const PROBE_META_KEY = "@probe_meta";

const NO_REPO_SOURCE_WARNING =
  "No repository source configured; set explicit_repos, owned_repos, or authored_external so sync can find items.";

const hasRepositorySource = (config) =>
  getConfigStringArray(config, "explicit_repos").length > 0 ||
  getConfigBoolean(config, "owned_repos") ||
  getConfigStringArray(config, "repo_conditions").length > 0 ||
  getConfigBoolean(config, "authored_external");

// --- the pure diff ---------------------------------------------------------

// Given the live source objects and the fingerprint baseline, emit events and
// return the new complete fingerprint map. No database; the host owns state.
const diff = (objects, fingerprints) => {
  const events = [];
  const next = {};
  const baseline = fingerprints ?? {};

  // De-duplicate by external_id (authored feeds can overlap repos), keeping the
  // last-seen object.
  const byExternalId = new Map();
  for (const object of objects) {
    byExternalId.set(object.external_id, object);
  }

  for (const object of byExternalId.values()) {
    next[object.external_id] = object.fingerprint;
    const prior = baseline[object.external_id];
    if (prior === undefined) {
      events.push({ entity: "item", lifecycle: "created", ...object });
    } else if (prior !== object.fingerprint) {
      events.push({
        entity: "item",
        lifecycle: "updated",
        ...object,
        // Re-triage the item: a moved fingerprint means new activity.
        local_state: "new",
        payload: { ...object.payload, local_state: "new" },
      });
    }
  }

  // external_ids that were in the baseline but no longer appear in the source
  // are closed. Reserved "@"-namespaced keys are plugin bookkeeping, not items.
  for (const externalId of Object.keys(baseline)) {
    if (!externalId.startsWith("github:")) {
      continue;
    }
    if (!(externalId in next)) {
      events.push({
        entity: "item",
        lifecycle: "closed",
        external_id: externalId,
        state: "closed",
        url: githubUrlForExternalId(externalId),
        fingerprint: "closed",
        payload: {
          type: externalId.startsWith("github:pr:")
            ? "pr_closed"
            : "issue_closed",
        },
      });
    }
  }

  return { events, fingerprints: next };
};

const syncGithubSource = async (input) => {
  const config = parseInputConfig(input);
  const baseline =
    Reflect.get(input, "fingerprints") !== null &&
    typeof Reflect.get(input, "fingerprints") === "object"
      ? Reflect.get(input, "fingerprints")
      : {};
  let username = getConfigString(config, "username");
  const explicitRepos = getConfigStringArray(config, "explicit_repos");
  const excludedRepos = new Set(getConfigStringArray(config, "exclude_repos"));
  const maxRepos = getConfigNumber(config, "max_repos", 100);
  const limit = getConfigNumber(config, "sync_limit_per_repo", 50);
  const lookbackDays = getConfigNumber(config, "lookback_days", 30);
  const staleThresholdMs = parseDurationMs(
    Reflect.get(config, "stale_threshold"),
  );

  try {
    await runGh(["auth", "status"]);
  } catch (error) {
    if (isRateLimitGhError(error)) {
      return rateLimitedResponse(error, baseline);
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      status: "permission_denied",
      events: [],
      fingerprints: baseline,
      has_more: false,
      warnings: [
        isMissingGhError(error)
          ? "GitHub CLI `gh` was not found; install gh and retry."
          : "GitHub CLI authentication is required for live sync; run `gh auth login` and retry.",
        // The actionable guidance above stays first (it is what surfaces in
        // status); the real `gh` failure rides along as a second warning so the
        // daemon log captures WHY auth-status failed (a network blip looks
        // different from a genuine sign-out).
        `gh auth status failed: ${sanitizeGhError(error)}`,
      ],
    };
  }

  if (username === null) {
    username = await deriveGhUsername();
  }

  // Deep activity probe throttle (FU-6). State rides in a reserved fingerprint
  // key so it survives across stateless sync calls without the host knowing.
  const probeEnabled = getConfigBoolean(config, "activity_probe");
  const probeIntervalSec = getConfigNumber(
    config,
    "activity_probe_interval",
    3600,
  );
  const priorProbeMeta =
    baseline[PROBE_META_KEY] !== null &&
    typeof baseline[PROBE_META_KEY] === "object"
      ? baseline[PROBE_META_KEY]
      : {};
  const lastProbeAt =
    typeof priorProbeMeta.last_probe_at === "string"
      ? priorProbeMeta.last_probe_at
      : null;
  const probeWindowElapsed =
    probeIntervalSec <= 0 ||
    lastProbeAt === null ||
    Date.now() - Date.parse(lastProbeAt) >= probeIntervalSec * 1000;
  const doProbe = probeEnabled && probeWindowElapsed;
  const cachedActivity =
    priorProbeMeta.activity !== null &&
    typeof priorProbeMeta.activity === "object"
      ? priorProbeMeta.activity
      : {};
  const nextActivity = {};
  // When probing is on we ALWAYS feed the same probe-derived value into the
  // fingerprint (fresh this cycle, or carried over from cache when throttled),
  // so the fingerprint method never flip-flops between cycles.
  const resolveActivity = probeEnabled
    ? async (itemType, repository, number) => {
        const kind = itemType === "pull_request" ? "pr" : "issue";
        const externalId = `github:${kind}:${repository}/${number}`;
        const value = doProbe
          ? await probeItemActivity(itemType, repository, number, username)
          : (cachedActivity[externalId] ?? null);
        nextActivity[externalId] = value;
        return { last_non_self_activity_at: value };
      }
    : null;

  try {
    const repos = new Set(explicitRepos);
    for (const condition of repoConditionsFromConfig(config)) {
      for (const repo of await discoverReposForCondition(
        condition,
        username,
        maxRepos,
      )) {
        repos.add(repo);
      }
    }

    const objects = [];
    for (const repository of repos) {
      if (excludedRepos.has(repository)) {
        continue;
      }
      objects.push(
        ...(await listLiveRepositoryObjects(
          repository,
          limit,
          username,
          resolveActivity,
          staleThresholdMs,
        )),
      );
    }

    if (getConfigBoolean(config, "authored_external") && username !== null) {
      const coveredRepos = new Set(
        [...repos].filter((repo) => !excludedRepos.has(repo)),
      );
      const authored = await listAuthoredObjects(
        username,
        lookbackDays,
        staleThresholdMs,
      );
      for (const object of authored) {
        const repository = object.payload.repository;
        if (!coveredRepos.has(repository) && !excludedRepos.has(repository)) {
          objects.push(object);
        }
      }
    }

    // Draft / WIP filtering (FU-10) + age filtering (FU-12). Excluded items
    // simply never enter the baseline; a PR later marked ready (or with fresh
    // activity) reappears as created.
    const excludeDrafts = getConfigBoolean(config, "exclude_drafts");
    const excludeWip = getConfigBoolean(config, "exclude_wip");
    const ignoreOlderThanMs = parseDurationMs(
      Reflect.get(config, "ignore_older_than"),
    );
    const oldestAllowed =
      ignoreOlderThanMs === null ? null : Date.now() - ignoreOlderThanMs;
    const visibleObjects =
      excludeDrafts || excludeWip || oldestAllowed !== null
        ? objects.filter((object) => {
            if (excludeDrafts && object.payload?.is_draft === true) {
              return false;
            }
            if (excludeWip && isWipTitle(object.title)) {
              return false;
            }
            if (
              oldestAllowed !== null &&
              typeof object.activity_at === "string" &&
              Date.parse(object.activity_at) < oldestAllowed
            ) {
              return false;
            }
            return true;
          })
        : objects;

    const { events, fingerprints } = diff(visibleObjects, baseline);

    if (probeEnabled) {
      fingerprints[PROBE_META_KEY] = {
        last_probe_at: doProbe ? new Date().toISOString() : lastProbeAt,
        activity: nextActivity,
      };
    }

    const warnings = [];
    if (!hasRepositorySource(config)) {
      warnings.push(NO_REPO_SOURCE_WARNING);
    }

    return {
      protocol_version: PROTOCOL_VERSION,
      status: "complete",
      events,
      fingerprints,
      has_more: false,
      warnings,
    };
  } catch (error) {
    if (isRateLimitGhError(error)) {
      return rateLimitedResponse(error, baseline);
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      status: "error",
      events: [],
      fingerprints: baseline,
      has_more: false,
      warnings: [`GitHub CLI command failed: ${sanitizeGhError(error)}`],
    };
  }
};

// --- fetch context ---------------------------------------------------------

const getRecordAuthorLogin = (record) => getGhActor(record);

const getRecordBody = (record) =>
  typeof Reflect.get(record, "body") === "string"
    ? Reflect.get(record, "body")
    : "";

const getRecordTitle = (record, fallback) =>
  typeof Reflect.get(record, "title") === "string"
    ? Reflect.get(record, "title")
    : fallback;

const getRecordUrl = (record, fallback) =>
  typeof Reflect.get(record, "url") === "string"
    ? Reflect.get(record, "url")
    : fallback;

const getIssueComments = (record) => {
  const comments = Reflect.get(record, "comments");
  return Array.isArray(comments)
    ? comments.filter(
        (comment) => comment !== null && typeof comment === "object",
      )
    : [];
};

const getPullRequestReviews = (record) => {
  const reviews = Reflect.get(record, "reviews");
  return Array.isArray(reviews)
    ? reviews.filter((review) => review !== null && typeof review === "object")
    : [];
};

const buildIssueFetchResponse = async (itemExternalId) => {
  const parsed = parseIssueExternalId(itemExternalId);
  if (parsed === null) {
    return null;
  }
  await runGh(["auth", "status"]);
  const record = JSON.parse(
    await runGh([
      "issue",
      "view",
      parsed.number,
      "--repo",
      parsed.repository,
      "--comments",
      "--json",
      "number,title,author,state,url,body,updatedAt,labels,comments",
    ]),
  );

  const issueNumber = Reflect.get(record, "number") ?? parsed.number;
  const title = getRecordTitle(record, `GitHub issue #${issueNumber}`);
  const url = getRecordUrl(
    record,
    `https://github.com/${parsed.repository}/issues/${issueNumber}`,
  );
  const author = getRecordAuthorLogin(record);
  const state =
    typeof Reflect.get(record, "state") === "string"
      ? Reflect.get(record, "state").toLowerCase()
      : "unknown";
  const body = getRecordBody(record);
  const comments = getIssueComments(record);
  const latestComment = comments[comments.length - 1];
  const latestCommentAuthor =
    latestComment === undefined ? null : getRecordAuthorLogin(latestComment);
  const latestCommentBody =
    latestComment === undefined ? null : getRecordBody(latestComment);
  const compactBody = body.length > 0 ? body : "No issue body provided.";
  const evidence = [];

  if (latestComment !== undefined) {
    evidence.push({
      id: `ev-github-issue-${issueNumber}-comment-1`,
      kind: "comment",
      source_ref: `${itemExternalId}#latest-comment`,
      summary: `${latestCommentAuthor} commented on issue #${issueNumber}.`,
      quote: latestCommentBody,
      url: getRecordUrl(latestComment, url),
    });
  }

  return {
    protocol_version: PROTOCOL_VERSION,
    item_external_id: itemExternalId,
    human_context: {
      title,
      compact: `${author} opened issue #${issueNumber} in ${parsed.repository}: ${compactBody}`,
      url,
    },
    agent_context: {
      compact: `GitHub issue #${issueNumber} in ${parsed.repository} is ${state}.`,
      full: [
        `Repository: ${parsed.repository}`,
        `Issue: #${issueNumber} ${title}`,
        `Author: ${author}`,
        `State: ${state}`,
        `Body: ${compactBody}`,
        ...(latestCommentAuthor !== null && latestCommentBody !== null
          ? [`Latest comment by ${latestCommentAuthor}: ${latestCommentBody}`]
          : []),
      ].join("\n"),
    },
    evidence,
    redaction_hints: [],
  };
};

const buildPullRequestFetchResponse = async (itemExternalId) => {
  const parsed = parsePullRequestExternalId(itemExternalId);
  if (parsed === null) {
    return null;
  }
  await runGh(["auth", "status"]);
  const record = JSON.parse(
    await runGh([
      "pr",
      "view",
      parsed.number,
      "--repo",
      parsed.repository,
      "--json",
      "number,title,author,state,url,body,updatedAt,labels,reviews,reviewDecision,statusCheckRollup,comments",
    ]),
  );

  const pullRequestNumber = Reflect.get(record, "number") ?? parsed.number;
  const title = getRecordTitle(
    record,
    `GitHub pull request #${pullRequestNumber}`,
  );
  const url = getRecordUrl(
    record,
    `https://github.com/${parsed.repository}/pull/${pullRequestNumber}`,
  );
  const author = getRecordAuthorLogin(record);
  const state =
    typeof Reflect.get(record, "state") === "string"
      ? Reflect.get(record, "state").toLowerCase()
      : "unknown";
  const body = getRecordBody(record);
  const reviews = getPullRequestReviews(record);
  const latestReview = reviews[reviews.length - 1];
  const latestReviewAuthor =
    latestReview === undefined ? null : getRecordAuthorLogin(latestReview);
  const latestReviewBody =
    latestReview === undefined ? null : getRecordBody(latestReview);
  const latestReviewState =
    latestReview !== undefined &&
    typeof Reflect.get(latestReview, "state") === "string"
      ? Reflect.get(latestReview, "state")
      : null;
  const compactBody = body.length > 0 ? body : "No pull request body provided.";
  const evidence = [];

  if (latestReview !== undefined) {
    evidence.push({
      id: `ev-github-pr-${pullRequestNumber}-review-1`,
      kind: "review",
      source_ref: `${itemExternalId}#latest-review`,
      summary: `${latestReviewAuthor} submitted ${latestReviewState} on pull request #${pullRequestNumber}.`,
      quote: latestReviewBody,
      url: getRecordUrl(latestReview, url),
    });
  }

  return {
    protocol_version: PROTOCOL_VERSION,
    item_external_id: itemExternalId,
    human_context: {
      title,
      compact: `${author} opened pull request #${pullRequestNumber} in ${parsed.repository}: ${compactBody}`,
      url,
    },
    agent_context: {
      compact: `GitHub pull request #${pullRequestNumber} in ${parsed.repository} is ${state}.`,
      full: [
        `Repository: ${parsed.repository}`,
        `Pull request: #${pullRequestNumber} ${title}`,
        `Author: ${author}`,
        `State: ${state}`,
        `Body: ${compactBody}`,
        ...(latestReviewAuthor !== null &&
        latestReviewState !== null &&
        latestReviewBody !== null
          ? [
              `Latest review by ${latestReviewAuthor}: ${latestReviewState} - ${latestReviewBody}`,
            ]
          : []),
      ].join("\n"),
    },
    evidence,
    redaction_hints: [],
  };
};

// --- manifest --------------------------------------------------------------

const MANIFEST = {
  protocol_version: PROTOCOL_VERSION,
  plugin: {
    id: "github",
    version: "2.0.0",
    display_name: "GitHub",
    publisher: "firstpass",
  },
  capabilities: ["sync", "fetch", "actions", "automation"],
  item_types: [
    { type: "issue", display_name: "Issue" },
    { type: "pull_request", display_name: "Pull Request" },
  ],
  action_types: [
    {
      type: "comment",
      display_name: "Comment",
      description: "Post a comment on a GitHub issue or pull request.",
      safety: "external_write",
      idempotency: "client_token",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: { body: { type: "string" } },
      },
    },
    {
      type: "close",
      display_name: "Close Item",
      description: "Close a GitHub issue or pull request after approval.",
      safety: "destructive",
      idempotency: "natural_key",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string" } },
      },
    },
    {
      type: "reopen",
      display_name: "Reopen Item",
      description:
        "Reopen a closed GitHub issue or pull request after approval.",
      safety: "external_write",
      idempotency: "natural_key",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string" } },
      },
    },
    {
      type: "review",
      display_name: "Submit Review",
      description: "Submit an approved pull request review with comments.",
      safety: "external_write",
      idempotency: "client_token",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["event", "body"],
        properties: {
          event: { type: "string" },
          body: { type: "string" },
        },
      },
    },
    {
      type: "merge",
      display_name: "Merge Pull Request",
      description:
        "Merge an approved pull request using merge, squash, or rebase.",
      safety: "destructive",
      idempotency: "natural_key",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          method: { type: "string", enum: ["merge", "squash", "rebase"] },
        },
      },
    },
  ],
};

const MERGE_METHODS = ["merge", "squash", "rebase"];
const mergeFlagFor = (method) =>
  method === "squash"
    ? "--squash"
    : method === "rebase"
      ? "--rebase"
      : "--merge";

// Merge methods the repository actually permits, so a requested method that the
// repo disallows can fall back to one it allows (mirrors ezoss's behavior).
const repoAllowedMergeMethods = async (repository) => {
  try {
    const record = JSON.parse(
      await runGh([
        "repo",
        "view",
        repository,
        "--json",
        "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
      ]),
    );
    const allowed = [];
    if (Reflect.get(record, "mergeCommitAllowed")) allowed.push("merge");
    if (Reflect.get(record, "squashMergeAllowed")) allowed.push("squash");
    if (Reflect.get(record, "rebaseMergeAllowed")) allowed.push("rebase");
    return allowed;
  } catch {
    return [];
  }
};

// Action safety mapping: close and merge are destructive, everything else is
// external_write.
const safetyForActionType = (actionType) =>
  actionType === "close" || actionType === "merge"
    ? "destructive"
    : "external_write";

// Contributor-safe action gating (FU-2). On items you authored in repos you do
// not maintain, maintainer-only actions (merge a PR, submit a review, reopen)
// are not available; contributor items support commenting and closing your own
// item only.
const MAINTAINER_ONLY_ACTIONS = new Set(["review", "merge", "reopen"]);

// Resolve the viewer's role for an item. Prefer the role the host stamped at
// sync time (authoritative, passed through as input.role); otherwise derive it
// from config + the item's repository so execute-action can still gate safely.
const resolveActionRole = (input, itemExternalId) => {
  const explicit = Reflect.get(input, "role");
  if (explicit === "contributor" || explicit === "maintainer") {
    return explicit;
  }
  const config = parseInputConfig(input);
  const parsed =
    parseIssueExternalId(itemExternalId) ??
    parsePullRequestExternalId(itemExternalId);
  const repository = parsed === null ? null : parsed.repository;
  if (repository === null) {
    return "maintainer";
  }
  if (new Set(getConfigStringArray(config, "explicit_repos")).has(repository)) {
    return "maintainer";
  }
  const username = getConfigString(config, "username");
  if (
    getConfigBoolean(config, "owned_repos") &&
    username !== null &&
    repository.startsWith(`${username}/`)
  ) {
    return "maintainer";
  }
  return getConfigBoolean(config, "authored_external")
    ? "contributor"
    : "maintainer";
};

// --- fix automation helpers (FU-13/14/15) ----------------------------------

const getNoMistakesBin = () =>
  typeof process.env.FIRSTPASS_NO_MISTAKES_BIN === "string" &&
  process.env.FIRSTPASS_NO_MISTAKES_BIN.length > 0
    ? process.env.FIRSTPASS_NO_MISTAKES_BIN
    : "no-mistakes";

const noMistakesAvailable = async () => {
  try {
    await execFileAsync(getNoMistakesBin(), ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

// Detect the URL of a PR opened from a given head branch. Returns null when no
// PR is found yet (the no-mistakes path opens the PR asynchronously).
const detectPrUrl = async (repository, branch) => {
  try {
    const records = parseGhJsonArray(
      await runGh([
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "url",
      ]),
    );
    const url = records.length > 0 ? Reflect.get(records[0], "url") : null;
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
};

const currentBranch = async (workspacePath) =>
  (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)).trim();

// --- command dispatch ------------------------------------------------------

const main = async () => {
  if (command === "manifest") {
    emit(MANIFEST);
    return;
  }

  if (command === "doctor") {
    try {
      await runGh(["--version"]);
      await runGh(["auth", "status"]);
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "ok",
        plugin: "github",
        checks: [
          {
            id: "github-cli",
            status: "ok",
            message: "GitHub CLI `gh` is installed and authenticated.",
          },
        ],
        warnings: [],
      });
    } catch (error) {
      const missing = isMissingGhError(error);
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "error",
        plugin: "github",
        checks: [
          {
            id: "github-cli",
            status: "error",
            message: missing
              ? "GitHub CLI `gh` was not found; install gh and retry."
              : "GitHub CLI is not authenticated; run `gh auth login` and retry.",
          },
        ],
        warnings: [
          missing
            ? "Install GitHub CLI from https://cli.github.com/ and run `gh auth login`."
            : "Run `gh auth login` before syncing GitHub sources.",
        ],
      });
    }
    return;
  }

  if (command === "configure") {
    const input = await readStdinJson();
    const config = parseInputConfig(input);
    let username = getConfigString(config, "username");
    let credentialSource = null;
    try {
      await runGh(["auth", "status"]);
      credentialSource = "gh";
    } catch {
      credentialSource = null;
    }
    if (username === null && credentialSource !== null) {
      username = await deriveGhUsername();
    }

    emit({
      protocol_version: PROTOCOL_VERSION,
      display_name: username === null ? "GitHub" : `GitHub ${username}`,
      credentials_required: credentialSource === null,
      warnings: [
        ...(credentialSource === null
          ? [
              "GitHub CLI authentication is required; run `gh auth login` before syncing.",
            ]
          : []),
        ...(hasRepositorySource(config) ? [] : [NO_REPO_SOURCE_WARNING]),
      ],
    });
    return;
  }

  if (command === "sync") {
    const input = await readStdinJson();
    // Convenience: a top-level repository field maps to explicit_repos.
    const repository =
      typeof Reflect.get(input, "repository") === "string" &&
      /^[^/\s]+\/[^/\s]+$/.test(Reflect.get(input, "repository"))
        ? Reflect.get(input, "repository")
        : null;
    if (repository !== null) {
      emit(
        await syncGithubSource({
          ...input,
          config: { ...parseInputConfig(input), explicit_repos: [repository] },
        }),
      );
    } else {
      emit(await syncGithubSource(input));
    }
    return;
  }

  if (command === "fetch") {
    const input = await readStdinJson();
    const itemExternalId =
      typeof Reflect.get(input, "item_external_id") === "string"
        ? Reflect.get(input, "item_external_id")
        : "github:issue:unknown/unknown/0";
    const itemUrl = githubUrlForExternalId(itemExternalId);
    try {
      const issueContext = await buildIssueFetchResponse(itemExternalId);
      if (issueContext !== null) {
        emit(issueContext);
        return;
      }
      const prContext = await buildPullRequestFetchResponse(itemExternalId);
      if (prContext !== null) {
        emit(prContext);
        return;
      }
    } catch (error) {
      // Fall through to placeholder context on gh failure.
      emit({
        protocol_version: PROTOCOL_VERSION,
        item_external_id: itemExternalId,
        human_context: {
          title: `GitHub item ${itemExternalId}`,
          compact: `GitHub context fetch failed: ${sanitizeGhError(error)}`,
          url: itemUrl,
        },
        agent_context: {
          compact: `No GitHub context available for ${itemExternalId}.`,
          full: `GitHub context fetch failed for ${itemExternalId}.`,
        },
        evidence: [],
        redaction_hints: [],
      });
      return;
    }

    emit({
      protocol_version: PROTOCOL_VERSION,
      item_external_id: itemExternalId,
      human_context: {
        title: `GitHub item ${itemExternalId}`,
        compact:
          "This GitHub item identity could not be parsed into an issue or pull request.",
        url: itemUrl,
      },
      agent_context: {
        compact: `No GitHub context available for ${itemExternalId}.`,
        full: [
          "Source: github",
          `Item: ${itemExternalId}`,
          "Only issue and pull request items are supported for context fetching.",
        ].join("\n"),
      },
      evidence: [
        {
          id: "ev-github-placeholder-1",
          kind: "metadata",
          source_ref: itemExternalId,
          summary: "Records the GitHub item requested for context fetching.",
          url: itemUrl,
        },
      ],
      redaction_hints: [],
    });
    return;
  }

  if (command === "validate-action") {
    const input = await readStdinJson();
    const itemExternalId =
      typeof Reflect.get(input, "item_external_id") === "string" &&
      Reflect.get(input, "item_external_id").trim().length > 0
        ? Reflect.get(input, "item_external_id")
        : "github:issue:unknown/unknown/0";
    const action = Reflect.get(input, "action");
    const hasAction =
      action !== null && typeof action === "object" && !Array.isArray(action);
    const actionType =
      hasAction && typeof Reflect.get(action, "action_type") === "string"
        ? Reflect.get(action, "action_type")
        : "comment";
    const params = hasAction ? Reflect.get(action, "params") : undefined;
    const hasParamsObject =
      params === undefined ||
      (params !== null && typeof params === "object" && !Array.isArray(params));
    const getParam = (key) =>
      params !== null && typeof params === "object"
        ? Reflect.get(params, key)
        : undefined;
    const commentBody =
      typeof getParam("body") === "string" ? getParam("body") : "";
    const reviewEvent =
      typeof getParam("event") === "string" ? getParam("event") : "";
    const reason = getParam("reason");
    const hasValidReason = reason === undefined || typeof reason === "string";

    const knownActionTypes = ["comment", "close", "reopen", "review", "merge"];
    const isKnown = knownActionTypes.includes(actionType);
    const mergeMethod =
      typeof getParam("method") === "string" ? getParam("method") : "";
    const isIssueOrPr =
      itemExternalId.startsWith("github:issue:") ||
      itemExternalId.startsWith("github:pr:");
    const isReviewTarget = itemExternalId.startsWith("github:pr:");
    const isSupportedReviewEvent =
      reviewEvent === "APPROVE" ||
      reviewEvent === "REQUEST_CHANGES" ||
      reviewEvent === "COMMENT";

    const warnings = [];
    let valid = true;
    if (!isKnown) {
      valid = false;
      warnings.push(
        `GitHub action type is not declared in the manifest: ${actionType}.`,
      );
    } else if (actionType === "comment") {
      if (!isIssueOrPr) {
        valid = false;
        warnings.push(
          "GitHub comment actions require an issue or pull request item.",
        );
      } else if (!hasParamsObject || commentBody.trim().length === 0) {
        valid = false;
        warnings.push("GitHub comment actions require params.body.");
      }
    } else if (actionType === "close" || actionType === "reopen") {
      if (!isIssueOrPr) {
        valid = false;
        warnings.push(
          `GitHub ${actionType} actions require an issue or pull request item.`,
        );
      } else if (!hasParamsObject || !hasValidReason) {
        valid = false;
        warnings.push(
          `GitHub ${actionType} actions require params.reason to be a string.`,
        );
      }
    } else if (actionType === "review") {
      if (!isReviewTarget) {
        valid = false;
        warnings.push("GitHub review actions require a pull request item.");
      } else if (
        !hasParamsObject ||
        !isSupportedReviewEvent ||
        commentBody.trim().length === 0
      ) {
        valid = false;
        warnings.push(
          "GitHub review actions require params.event (APPROVE, REQUEST_CHANGES, or COMMENT) and params.body.",
        );
      }
    } else if (actionType === "merge") {
      if (!isReviewTarget) {
        valid = false;
        warnings.push("GitHub merge actions require a pull request item.");
      } else if (
        !hasParamsObject ||
        (mergeMethod.length > 0 && !MERGE_METHODS.includes(mergeMethod))
      ) {
        valid = false;
        warnings.push(
          "GitHub merge actions accept params.method of merge, squash, or rebase.",
        );
      }
    }

    const role = resolveActionRole(input, itemExternalId);
    if (role === "contributor" && MAINTAINER_ONLY_ACTIONS.has(actionType)) {
      valid = false;
      warnings.push(
        `GitHub ${actionType} is a maintainer-only action and is not available for contributor items.`,
      );
    }

    emit({
      protocol_version: PROTOCOL_VERSION,
      item_external_id: itemExternalId,
      action_type: actionType,
      role,
      valid,
      safety: safetyForActionType(actionType),
      warnings,
    });
    return;
  }

  if (command === "preview-action") {
    const input = await readStdinJson();
    const itemExternalId =
      typeof Reflect.get(input, "item_external_id") === "string"
        ? Reflect.get(input, "item_external_id")
        : "github:issue:unknown/unknown/0";
    const action = Reflect.get(input, "action");
    const actionType =
      action !== null &&
      typeof action === "object" &&
      typeof Reflect.get(action, "action_type") === "string"
        ? Reflect.get(action, "action_type")
        : "comment";
    const params =
      action !== null && typeof action === "object"
        ? Reflect.get(action, "params")
        : undefined;
    const getParam = (key) =>
      params !== null && typeof params === "object"
        ? Reflect.get(params, key)
        : undefined;
    const body = typeof getParam("body") === "string" ? getParam("body") : "";
    const reviewEvent =
      typeof getParam("event") === "string" ? getParam("event") : "";
    const reason =
      typeof getParam("reason") === "string" ? getParam("reason") : "";

    const previewBody =
      actionType === "review" && reviewEvent.length > 0
        ? [
            `Target: ${githubUrlForExternalId(itemExternalId)}`,
            `Review event: ${reviewEvent}`,
            "",
            body,
          ].join("\n")
        : actionType === "close" || actionType === "reopen"
          ? [
              `Target: ${githubUrlForExternalId(itemExternalId)}`,
              `${actionType === "close" ? "Close" : "Reopen"} comment: ${reason}`,
            ].join("\n")
          : [
              `Target: ${githubUrlForExternalId(itemExternalId)}`,
              "",
              body,
            ].join("\n");

    emit({
      protocol_version: PROTOCOL_VERSION,
      item_external_id: itemExternalId,
      action_type: actionType,
      safety: safetyForActionType(actionType),
      summary: `Preview GitHub ${actionType} on ${itemExternalId}.`,
      preview: { content_type: "text/markdown", body: previewBody },
      warnings: [],
    });
    return;
  }

  if (command === "execute-action") {
    const input = await readStdinJson();
    const itemExternalId =
      typeof Reflect.get(input, "item_external_id") === "string"
        ? Reflect.get(input, "item_external_id")
        : "github:issue:unknown/unknown/0";
    const approvalId =
      typeof Reflect.get(input, "approval_id") === "string"
        ? Reflect.get(input, "approval_id")
        : "approval-unknown";
    const action = Reflect.get(input, "action");
    const actionType =
      action !== null &&
      typeof action === "object" &&
      typeof Reflect.get(action, "action_type") === "string"
        ? Reflect.get(action, "action_type")
        : "comment";
    const params =
      action !== null && typeof action === "object"
        ? Reflect.get(action, "params")
        : undefined;
    const getParam = (key) =>
      params !== null && typeof params === "object"
        ? Reflect.get(params, key)
        : undefined;
    const commentBody =
      typeof getParam("body") === "string" ? getParam("body") : "";
    const reviewEvent =
      typeof getParam("event") === "string" ? getParam("event") : "";
    const reviewBody =
      typeof getParam("body") === "string" ? getParam("body") : "";
    const reason =
      typeof getParam("reason") === "string" ? getParam("reason") : "";

    const issueTarget = parseIssueExternalId(itemExternalId);
    const prTarget = parsePullRequestExternalId(itemExternalId);
    const reviewThreadTarget = parseReviewThreadExternalId(itemExternalId);

    const externalResult = { url: githubUrlForExternalId(itemExternalId) };

    const fail = (auditSummary, warning) =>
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "failed",
        external_result: externalResult,
        audit_summary: auditSummary,
        error: warning,
        warnings: [warning],
      });

    const succeed = (auditSummary) =>
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "succeeded",
        external_result: externalResult,
        audit_summary: auditSummary,
        warnings: [],
      });

    // The adapter supports comment/close/reopen/review/merge on issues and PRs.
    // Review threads and other action types are unsupported.
    const unsupported =
      !["comment", "close", "reopen", "review", "merge"].includes(actionType) ||
      reviewThreadTarget !== null;
    if (unsupported) {
      fail(
        `GitHub action ${actionType} is not supported by the MVP adapter for approval ${approvalId}.`,
        "GitHub MVP supports comment, close, reopen, and pull request review actions only.",
      );
      return;
    }

    const target = issueTarget ?? prTarget;
    if (target === null || approvalId === "approval-unknown") {
      fail(
        `GitHub ${actionType} action was not executed for approval ${approvalId}; no supported gh target was available.`,
        "GitHub action execution requires a supported issue or pull request target and an approval id.",
      );
      return;
    }
    const isPr = prTarget !== null;
    const kind = isPr ? "pr" : "issue";

    const role = resolveActionRole(input, itemExternalId);
    if (role === "contributor" && MAINTAINER_ONLY_ACTIONS.has(actionType)) {
      fail(
        `GitHub ${actionType} is maintainer-only and was refused for contributor item ${itemExternalId} (approval ${approvalId}).`,
        `GitHub ${actionType} is not available for contributor items; contributor items support comment and close only.`,
      );
      return;
    }

    try {
      await runGh(["auth", "status"]);

      if (actionType === "comment" && commentBody.trim().length > 0) {
        const commentUrl = (
          await runGh([
            kind,
            "comment",
            target.number,
            "--repo",
            target.repository,
            "--body",
            commentBody,
          ])
        ).trim();
        if (commentUrl.length > 0) {
          Reflect.set(externalResult, "comment_url", commentUrl);
        }
        succeed(
          `Live GitHub comment executed for approval ${approvalId} using gh ${kind} comment.`,
        );
        return;
      }

      if (actionType === "close") {
        await runGh([
          kind,
          "close",
          target.number,
          "--repo",
          target.repository,
          ...(reason.length > 0 ? ["--comment", reason] : []),
        ]);
        Reflect.set(
          externalResult,
          "state_url",
          `${githubUrlForExternalId(itemExternalId)}#state-closed`,
        );
        succeed(
          `Live GitHub close action executed for approval ${approvalId} using gh ${kind} close.`,
        );
        return;
      }

      if (actionType === "reopen") {
        await runGh([
          kind,
          "reopen",
          target.number,
          "--repo",
          target.repository,
          ...(reason.length > 0 ? ["--comment", reason] : []),
        ]);
        Reflect.set(
          externalResult,
          "state_url",
          `${githubUrlForExternalId(itemExternalId)}#state-open`,
        );
        succeed(
          `Live GitHub reopen action executed for approval ${approvalId} using gh ${kind} reopen.`,
        );
        return;
      }

      if (
        actionType === "review" &&
        isPr &&
        reviewEvent.length > 0 &&
        reviewBody.trim().length > 0
      ) {
        const ghReviewFlag =
          reviewEvent === "APPROVE"
            ? "--approve"
            : reviewEvent === "REQUEST_CHANGES"
              ? "--request-changes"
              : "--comment";
        await runGh([
          "pr",
          "review",
          target.number,
          "--repo",
          target.repository,
          ghReviewFlag,
          "--body",
          reviewBody,
        ]);
        Reflect.set(
          externalResult,
          "review_url",
          `${githubUrlForExternalId(itemExternalId)}#review-${reviewEvent}`,
        );
        succeed(
          `Live GitHub review action executed for approval ${approvalId} using gh pr review.`,
        );
        return;
      }

      if (actionType === "merge" && isPr) {
        const requested =
          typeof getParam("method") === "string" &&
          MERGE_METHODS.includes(getParam("method"))
            ? getParam("method")
            : (getConfigString(parseInputConfig(input), "merge_method") ??
              "merge");
        const runMerge = (method) =>
          runGh([
            "pr",
            "merge",
            target.number,
            "--repo",
            target.repository,
            mergeFlagFor(method),
          ]);
        let used = requested;
        try {
          await runMerge(requested);
        } catch (mergeErr) {
          // The repo may disallow the requested method; fall back to one it
          // permits before giving up.
          const allowed = await repoAllowedMergeMethods(target.repository);
          const fallback = allowed.find((m) => m !== requested);
          if (fallback === undefined) {
            throw mergeErr;
          }
          await runMerge(fallback);
          used = fallback;
        }
        Reflect.set(externalResult, "merge_method", used);
        Reflect.set(
          externalResult,
          "state_url",
          `${githubUrlForExternalId(itemExternalId)}#merged`,
        );
        succeed(
          `Live GitHub merge executed for approval ${approvalId} using gh pr merge ${mergeFlagFor(used)}.`,
        );
        return;
      }

      fail(
        `GitHub ${actionType} action was not executed for approval ${approvalId}; required parameters were missing.`,
        "GitHub action execution requires the expected parameters for the action type.",
      );
    } catch (error) {
      fail(
        `Live GitHub ${actionType} action failed for approval ${approvalId}: ${sanitizeGhError(error)}`,
        `GitHub CLI ${actionType} execution failed; verify \`gh auth status\` and retry.`,
      );
    }
    return;
  }

  if (command === "prepare-automation-workspace") {
    const input = await readStdinJson();
    const job = Reflect.get(input, "job");
    const jobId =
      job !== null && typeof job === "object"
        ? (Reflect.get(job, "id") ?? "job")
        : "job";
    const itemExternalId =
      job !== null &&
      typeof job === "object" &&
      typeof Reflect.get(job, "item_external_id") === "string"
        ? Reflect.get(job, "item_external_id")
        : null;
    const target =
      itemExternalId === null
        ? null
        : (parseIssueExternalId(itemExternalId) ??
          parsePullRequestExternalId(itemExternalId));

    if (target === null) {
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "failed",
        error:
          "Automation requires a GitHub issue or pull request item external id.",
        warnings: [
          "Could not derive a repository from the job's item external id.",
        ],
      });
      return;
    }

    const role =
      job !== null &&
      typeof job === "object" &&
      Reflect.get(job, "role") === "contributor"
        ? "contributor"
        : "maintainer";
    const isPr = parsePullRequestExternalId(itemExternalId) !== null;

    try {
      await runGh(["auth", "status"]);
      const workspaceRoot = await mkdtemp(join(tmpdir(), "firstpass-gh-ws-"));
      const workspacePath = join(workspaceRoot, "repo");
      await runGh(["repo", "clone", target.repository, workspacePath]);
      const defaultBranch = (
        await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)
      ).trim();

      if (role === "contributor" && isPr) {
        // Contributor fixes edit the authored PR's existing head branch
        // (FU-14) instead of opening a fresh branch/PR.
        await runGh(["pr", "checkout", String(target.number)], {
          cwd: workspacePath,
        });
        const branch = await currentBranch(workspacePath);
        emit({
          protocol_version: PROTOCOL_VERSION,
          status: "prepared",
          workspace_path: workspacePath,
          base_ref: branch,
          branch,
          mode: "contributor",
          warnings: [],
        });
        return;
      }

      const branch = `firstpass/fix-${jobId}`;
      await runGit(["checkout", "-b", branch], workspacePath);
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "prepared",
        workspace_path: workspacePath,
        base_ref: defaultBranch.length > 0 ? defaultBranch : "main",
        branch,
        mode: "maintainer",
        warnings: [],
      });
    } catch (error) {
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "failed",
        error: sanitizeGhError(error),
        warnings: [
          isMissingGhError(error)
            ? "GitHub CLI `gh` was not found; install gh and retry."
            : "Failed to prepare GitHub automation workspace; verify `gh auth status` and repository access.",
        ],
      });
    }
    return;
  }

  if (command === "submit-automation-workspace") {
    const input = await readStdinJson();
    const job = Reflect.get(input, "job");
    const jobId =
      job !== null && typeof job === "object"
        ? (Reflect.get(job, "id") ?? "job")
        : "job";
    const workspacePath =
      typeof Reflect.get(input, "workspace_path") === "string"
        ? Reflect.get(input, "workspace_path")
        : null;

    if (workspacePath === null) {
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "failed",
        error: "submit-automation-workspace requires a workspace_path.",
        warnings: ["No workspace path was provided."],
      });
      return;
    }

    try {
      const statusOut = (
        await runGit(["status", "--porcelain"], workspacePath)
      ).trim();
      if (statusOut.length === 0) {
        emit({
          protocol_version: PROTOCOL_VERSION,
          status: "no_changes",
          warnings: ["No changes were produced in the workspace."],
        });
        return;
      }

      await runGit(["add", "-A"], workspacePath);
      await runGit(
        ["commit", "-m", `firstpass automated fix for job ${jobId}`],
        workspacePath,
      );
      // Branch name is read after the commit so an unborn HEAD (fresh checkout
      // -b with no commit yet) does not trip `git rev-parse`.
      const branch = await currentBranch(workspacePath);
      const commit = (
        await runGit(["rev-parse", "HEAD"], workspacePath)
      ).trim();

      const config = parseInputConfig(input);
      const itemExternalId =
        job !== null && typeof job === "object"
          ? Reflect.get(job, "item_external_id")
          : null;
      const repository =
        typeof itemExternalId === "string"
          ? (parseIssueExternalId(itemExternalId)?.repository ??
            parsePullRequestExternalId(itemExternalId)?.repository ??
            null)
          : null;
      const role =
        job !== null &&
        typeof job === "object" &&
        Reflect.get(job, "role") === "contributor"
          ? "contributor"
          : "maintainer";

      // Contributor fixes update the existing authored PR branch (FU-14).
      if (role === "contributor") {
        const contribPush = (
          getConfigString(config, "fix_contrib_push") ?? "no-mistakes"
        ).toLowerCase();
        if (contribPush === "disabled") {
          emit({
            protocol_version: PROTOCOL_VERSION,
            status: "failed",
            commit,
            branch,
            error: "fix_contrib_push=disabled refuses contributor fix pushes.",
            warnings: [],
          });
          return;
        }
        if (contribPush === "auto") {
          await runGit(["push"], workspacePath);
          const prUrl =
            repository === null ? null : await detectPrUrl(repository, branch);
          emit({
            protocol_version: PROTOCOL_VERSION,
            status: "submitted",
            commit,
            branch,
            repository: repository ?? undefined,
            ...(prUrl ? { pr_url: prUrl } : {}),
            warnings: [],
          });
          return;
        }
        // no-mistakes (default): leave the commit for manual review and push.
        emit({
          protocol_version: PROTOCOL_VERSION,
          status: "waiting_for_pr",
          commit,
          branch,
          repository: repository ?? undefined,
          warnings: [
            "fix_contrib_push=no-mistakes: commit left in the workspace for manual review and push.",
          ],
        });
        return;
      }

      // Maintainer fixes open a draft PR per fix_pr_create (FU-13).
      const prCreate = (
        getConfigString(config, "fix_pr_create") ?? "auto"
      ).toLowerCase();

      if (prCreate === "disabled") {
        await runGit(["push", "-u", "origin", branch], workspacePath);
        emit({
          protocol_version: PROTOCOL_VERSION,
          status: "submitted",
          commit,
          branch,
          repository: repository ?? undefined,
          warnings: [
            "fix_pr_create=disabled: branch pushed without opening a pull request.",
          ],
        });
        return;
      }

      const effectiveMode =
        prCreate === "auto"
          ? (await noMistakesAvailable())
            ? "no-mistakes"
            : "gh"
          : prCreate;

      if (effectiveMode === "no-mistakes") {
        try {
          await execFileAsync(getNoMistakesBin(), ["push"], {
            cwd: workspacePath,
            timeout: 120000,
          });
        } catch (nmError) {
          if (prCreate === "auto") {
            // Fall back to gh when no-mistakes fails before PR detection.
            await runGit(["push", "-u", "origin", branch], workspacePath);
            const prUrl = (
              await runGh(
                ["pr", "create", "--draft", "--fill", "--head", branch],
                { cwd: workspacePath },
              )
            ).trim();
            emit({
              protocol_version: PROTOCOL_VERSION,
              status: "submitted",
              pr_url: prUrl,
              commit,
              branch,
              repository: repository ?? undefined,
              warnings: ["no-mistakes failed; fell back to gh pr create."],
            });
            return;
          }
          throw nmError;
        }
        const prUrl =
          repository === null ? null : await detectPrUrl(repository, branch);
        emit({
          protocol_version: PROTOCOL_VERSION,
          status: prUrl ? "submitted" : "waiting_for_pr",
          commit,
          branch,
          repository: repository ?? undefined,
          ...(prUrl ? { pr_url: prUrl } : {}),
          warnings: prUrl
            ? []
            : [
                "no-mistakes pushed the branch; PR not detected yet. Re-run `firstpass job attach` to recheck.",
              ],
        });
        return;
      }

      // gh mode: push to origin and open a draft PR.
      await runGit(["push", "-u", "origin", branch], workspacePath);
      const prUrl = (
        await runGh(
          [
            "pr",
            "create",
            "--draft",
            "--fill",
            "--head",
            branch,
            "--title",
            `firstpass fix: job ${jobId}`,
            "--body",
            `Automated fix prepared by FirstPass for job ${jobId}.`,
          ],
          { cwd: workspacePath },
        )
      ).trim();

      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "submitted",
        pr_url: prUrl,
        commit,
        branch,
        repository: repository ?? undefined,
        warnings: [],
      });
    } catch (error) {
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "failed",
        error: sanitizeGhError(error),
        warnings: [
          "Failed to submit GitHub automation workspace; verify `gh auth status` and push access.",
        ],
      });
    }
    return;
  }

  if (command === "detect-automation-pr") {
    const input = await readStdinJson();
    const repository =
      typeof Reflect.get(input, "repository") === "string"
        ? Reflect.get(input, "repository")
        : null;
    const branch =
      typeof Reflect.get(input, "branch") === "string"
        ? Reflect.get(input, "branch")
        : null;
    if (repository === null || branch === null) {
      emit({
        protocol_version: PROTOCOL_VERSION,
        status: "failed",
        error: "detect-automation-pr requires repository and branch.",
        warnings: [],
      });
      return;
    }
    const prUrl = await detectPrUrl(repository, branch);
    emit({
      protocol_version: PROTOCOL_VERSION,
      status: prUrl ? "submitted" : "waiting_for_pr",
      ...(prUrl ? { pr_url: prUrl } : {}),
      warnings: prUrl ? [] : ["No pull request detected yet for this branch."],
    });
    return;
  }

  process.stderr.write(`unknown command: ${command ?? ""}\n`);
  process.exitCode = 1;
};

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
});
