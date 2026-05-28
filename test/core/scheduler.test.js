import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import {
  selectPluginsDueForSync,
  syncRetryDelayMs,
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_CAP_MS,
} from "../../src/core/scheduler.js";

const insertPlugin = (db, id, over = {}) => {
  const row = {
    status: "active",
    consecutive_failures: 0,
    next_retry_at: null,
    ...over,
  };
  db.prepare(
    `insert into plugins
       (id, binary_path, version, protocol_version, manifest_json, config_json,
        status, consecutive_failures, next_retry_at, installed_at)
     values (?, '/bin/x', '2.0.0', 'firstpass.plugin.v2', '{}', '{}', ?, ?, ?, 't')`,
  ).run(id, row.status, row.consecutive_failures, row.next_retry_at);
};

describe("core/scheduler: syncRetryDelayMs", () => {
  it("uses the plugin-supplied retry_after_seconds when present", () => {
    expect(syncRetryDelayMs(3, 30)).toBe(30_000);
    expect(syncRetryDelayMs(1, 90)).toBe(90_000);
  });

  it("falls back to capped exponential backoff by failure count", () => {
    expect(syncRetryDelayMs(1)).toBe(SYNC_BACKOFF_BASE_MS);
    expect(syncRetryDelayMs(2)).toBe(SYNC_BACKOFF_BASE_MS * 2);
    expect(syncRetryDelayMs(3)).toBe(SYNC_BACKOFF_BASE_MS * 4);
  });

  it("caps the exponential backoff", () => {
    expect(syncRetryDelayMs(100)).toBe(SYNC_BACKOFF_CAP_MS);
  });

  it("ignores a non-positive retry_after and uses backoff instead", () => {
    expect(syncRetryDelayMs(1, 0)).toBe(SYNC_BACKOFF_BASE_MS);
    expect(syncRetryDelayMs(1, -5)).toBe(SYNC_BACKOFF_BASE_MS);
  });
});

describe("core/scheduler: selectPluginsDueForSync", () => {
  let dir;
  let db;
  const now = "2026-05-28T12:00:00.000Z";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-sched-"));
    db = createDatabase(join(dir, "s.sqlite"));
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ids = (rows) => rows.map((r) => r.id).sort();

  it("includes active plugins and plugins with a null status", () => {
    insertPlugin(db, "active-one", { status: "active" });
    insertPlugin(db, "null-one", { status: null });
    expect(ids(selectPluginsDueForSync(db, now))).toEqual([
      "active-one",
      "null-one",
    ]);
  });

  it("excludes an errored plugin whose next_retry_at is still in the future", () => {
    insertPlugin(db, "parked", {
      status: "permission_denied",
      consecutive_failures: 1,
      next_retry_at: "2026-05-28T12:05:00.000Z", // after `now`
    });
    expect(ids(selectPluginsDueForSync(db, now))).toEqual([]);
  });

  it("self-heals: includes an errored plugin once next_retry_at has elapsed", () => {
    // This is the regression guard for the latched-forever bug: a
    // permission_denied plugin must re-enter the sync rotation after backoff.
    insertPlugin(db, "recovering", {
      status: "permission_denied",
      consecutive_failures: 2,
      next_retry_at: "2026-05-28T11:59:00.000Z", // before `now`
    });
    expect(ids(selectPluginsDueForSync(db, now))).toEqual(["recovering"]);
  });

  it("treats a legacy errored plugin (null next_retry_at) as due now", () => {
    // Migration adds next_retry_at as NULL for rows parked before the column
    // existed. Such a plugin must re-enter the rotation immediately, otherwise
    // the fix would never unstick plugins that were already latched off.
    insertPlugin(db, "legacy", {
      status: "permission_denied",
      consecutive_failures: 1,
      next_retry_at: null,
    });
    expect(ids(selectPluginsDueForSync(db, now))).toEqual(["legacy"]);
  });

  it("includes a rate_limited plugin whose retry window has elapsed", () => {
    insertPlugin(db, "rl", {
      status: "rate_limited",
      consecutive_failures: 1,
      next_retry_at: "2026-05-28T11:00:00.000Z",
    });
    expect(ids(selectPluginsDueForSync(db, now))).toEqual(["rl"]);
  });
});
