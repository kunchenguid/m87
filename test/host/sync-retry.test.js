import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { createLoop } from "../../src/core/loop.js";
import { readManifest } from "../../src/host/plugin.js";
import { createEffects } from "../../src/host/effects.js";

const MOCK = fileURLToPath(
  new URL("../../plugins/mock/firstpass-src-mock.js", import.meta.url),
);

// A logger that records every line so we can assert the daemon would log the
// failure (and its detail) rather than swallowing it.
const makeCapturingLogger = () => {
  const lines = [];
  const push = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
};

describe("host/effects sync: transient-failure retry state", () => {
  let dir;
  let db;
  let logger;

  const insertMock = (config) =>
    db
      .prepare(
        `insert into plugins (id, binary_path, version, protocol_version, manifest_json, config_json, status, installed_at)
         values ('mock', ?, '2.0.0', 'firstpass.plugin.v2', ?, ?, 'active', 't')`,
      )
      .run(MOCK, "{}", JSON.stringify(config));

  const runSync = async () => {
    const effects = createEffects({ db, stateDir: dir, config: {}, logger });
    const loop = createLoop({ db, effects });
    loop.launchEffect({ type: "sync", plugin_id: "mock" });
    await loop.settle();
  };

  const pluginRow = () =>
    db.prepare("select * from plugins where id='mock'").get();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-retry-"));
    db = createDatabase(join(dir, "r.sqlite"));
    logger = makeCapturingLogger();
    // readManifest validates the mock is reachable; not strictly required here.
    await readManifest(MOCK);
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parks a permission_denied plugin behind a future next_retry_at (not forever)", async () => {
    insertMock({ scenario: "permission_denied" });
    await runSync();

    const row = pluginRow();
    expect(row.status).toBe("permission_denied");
    expect(row.consecutive_failures).toBe(1);
    expect(row.next_retry_at).toBeTruthy();
    // the retry window must be in the future relative to the recorded attempt
    expect(Date.parse(row.next_retry_at)).toBeGreaterThan(
      Date.parse(row.last_sync_at),
    );
  });

  it("escalates the backoff on a second consecutive failure", async () => {
    insertMock({ scenario: "permission_denied" });
    await runSync();
    const first = pluginRow();
    await runSync();
    const second = pluginRow();

    expect(second.consecutive_failures).toBe(2);
    const firstGap =
      Date.parse(first.next_retry_at) - Date.parse(first.last_sync_at);
    const secondGap =
      Date.parse(second.next_retry_at) - Date.parse(second.last_sync_at);
    expect(secondGap).toBeGreaterThan(firstGap);
  });

  it("honors the plugin's retry_after_seconds for rate limits", async () => {
    insertMock({ scenario: "rate_limited" }); // mock returns retry_after_seconds: 30
    await runSync();

    const row = pluginRow();
    expect(row.status).toBe("rate_limited");
    const gap = Date.parse(row.next_retry_at) - Date.parse(row.last_sync_at);
    expect(gap).toBe(30_000);
  });

  it("resets failure state and re-activates after a successful sync", async () => {
    insertMock({ scenario: "permission_denied" });
    await runSync();
    expect(pluginRow().consecutive_failures).toBe(1);

    // The source recovers: clear the failing scenario, then sync again.
    db.prepare("update plugins set config_json='{}' where id='mock'").run();
    await runSync();

    const row = pluginRow();
    expect(row.status).toBe("active");
    expect(row.consecutive_failures).toBe(0);
    expect(row.next_retry_at).toBeNull();
    expect(row.last_error).toBeNull();
  });

  it("logs the failure with the plugin id, status, and detail", async () => {
    insertMock({ scenario: "permission_denied" });
    await runSync();

    const warn = logger.lines.find((l) => l.level === "warn");
    expect(warn, "expected a warn log line").toBeTruthy();
    expect(warn.fields.plugin).toBe("mock");
    expect(warn.fields.status).toBe("permission_denied");
    expect(String(warn.fields.error)).toContain("permission denied");
  });
});
