import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import {
  prCheckDelayMs,
  PR_CHECK_BASE_MS,
  selectJobsDueForPrCheck,
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
     values (?, '/bin/x', '2.0.0', 'm87.plugin.v2', '{}', '{}', ?, ?, ?, 't')`,
  ).run(id, row.status, row.consecutive_failures, row.next_retry_at);
};

describe("core/scheduler: syncRetryDelayMs", () => {
  it("uses the plugin-supplied retry_after_seconds when present", () => {
    expect(syncRetryDelayMs(3, 30)).toBe(30_000);
    expect(syncRetryDelayMs(1, 90)).toBe(90_000);
  });

  it("caps plugin-supplied retry_after_seconds", () => {
    expect(syncRetryDelayMs(1, 24 * 60 * 60)).toBe(SYNC_BACKOFF_CAP_MS);
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
    dir = mkdtempSync(join(tmpdir(), "m87-sched-"));
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

describe("core/scheduler: prCheckDelayMs", () => {
  const CAP = 300_000; // a 5-minute poll interval

  it("starts at the base delay and doubles per attempt", () => {
    expect(prCheckDelayMs(0, CAP)).toBe(PR_CHECK_BASE_MS);
    expect(prCheckDelayMs(1, CAP)).toBe(PR_CHECK_BASE_MS * 2);
    expect(prCheckDelayMs(2, CAP)).toBe(PR_CHECK_BASE_MS * 4);
  });

  it("caps at the poll interval and never gives up", () => {
    expect(prCheckDelayMs(10, CAP)).toBe(CAP);
    expect(prCheckDelayMs(10_000, CAP)).toBe(CAP);
  });

  it("never drops below the base delay even for a tiny cap", () => {
    expect(prCheckDelayMs(0, 1_000)).toBe(PR_CHECK_BASE_MS);
  });
});

describe("core/scheduler: selectJobsDueForPrCheck", () => {
  let dir;
  let db;
  const now = "2026-05-28T12:00:00.000Z";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m87-prcheck-"));
    db = createDatabase(join(dir, "s.sqlite"));
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const insertJob = (db, id, over = {}) => {
    const row = {
      status: "running",
      phase: "waiting_for_pr",
      check_attempts: 0,
      next_check_at: null,
      ...over,
    };
    db.prepare(
      `insert into jobs
         (id, item_id, kind, status, phase, prompt, metadata_json,
          check_attempts, next_check_at, created_at, started_at, updated_at)
       values (?, 'item-1', 'fix', ?, ?, '', '{}', ?, ?, 't', 't', 't')`,
    ).run(id, row.status, row.phase, row.check_attempts, row.next_check_at);
  };

  const ids = (rows) => rows.map((r) => r.id).sort();

  it("includes a waiting job whose next_check_at has elapsed", () => {
    insertJob(db, "due", { next_check_at: "2026-05-28T11:59:00.000Z" });
    expect(ids(selectJobsDueForPrCheck(db, now))).toEqual(["due"]);
  });

  it("excludes a waiting job whose next_check_at is still in the future", () => {
    insertJob(db, "later", { next_check_at: "2026-05-28T12:01:00.000Z" });
    expect(ids(selectJobsDueForPrCheck(db, now))).toEqual([]);
  });

  it("treats a legacy waiting job (null next_check_at) as due now", () => {
    // Jobs parked in waiting_for_pr before the recheck policy existed must
    // re-enter the probe rotation immediately - this is the fix for jobs that
    // previously waited forever for a manual `m87 job attach`.
    insertJob(db, "legacy", { next_check_at: null });
    expect(ids(selectJobsDueForPrCheck(db, now))).toEqual(["legacy"]);
  });

  it("excludes jobs that are not running in waiting_for_pr", () => {
    insertJob(db, "working", { phase: "running_agent" });
    insertJob(db, "done", { status: "succeeded", phase: "pr_opened" });
    insertJob(db, "dead", { status: "failed", phase: "failed" });
    expect(ids(selectJobsDueForPrCheck(db, now))).toEqual([]);
  });
});
