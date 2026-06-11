import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { makeEvent } from "../../src/core/event.js";
import { project } from "../../src/core/projections.js";
import { createEffects } from "../../src/host/effects.js";

// A minimal fake plugin that answers detect-automation-pr based on an env flag.
async function writeFakeDetectPlugin(found) {
  const dir = await mkdtemp(join(tmpdir(), "m87-detect-plugin-"));
  const path = join(dir, "plugin.js");
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      "const cmd = process.argv[2];",
      'const emit = (v) => process.stdout.write(JSON.stringify(v) + "\\n");',
      'if (cmd === "detect-automation-pr") {',
      found
        ? '  emit({ status: "submitted", pr_url: "https://github.com/o/r/pull/5" });'
        : '  emit({ status: "waiting_for_pr" });',
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

function collector() {
  const events = [];
  return {
    events,
    api: {
      emit: (input) => events.push(input),
      emitEvent: (event) => events.push(event),
    },
  };
}

describe("host/effects fix_detect (FU-15)", () => {
  let dir;
  let db;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "m87-detect-"));
    db = createDatabase(join(dir, "t.sqlite"));
  });
  afterEach(() => {
    db?.close();
  });

  async function seed(binaryPath) {
    db.prepare(
      `insert into plugins (id, binary_path, version, protocol_version, manifest_json, config_json, status, installed_at)
       values ('github', ?, '2', 'm87.plugin.v2', '{}', '{}', 'active', 't')`,
    ).run(binaryPath);
    project(
      db,
      makeEvent({
        actor: "plugin:github",
        entity: "item",
        lifecycle: "created",
        item_id: "github:github:pr:o/r/5",
        plugin_id: "github",
        envelope: { title: "x", state: "open", url: "u", fingerprint: "fp" },
        attention: { should_surface: true },
        payload: {
          type: "pr_opened",
          external_id: "github:pr:o/r/5",
          item_type: "pull_request",
        },
      }),
    );
    db.prepare(
      `insert into jobs (id, item_id, kind, status, phase, prompt, metadata_json, created_at, updated_at)
       values ('job-1','github:github:pr:o/r/5','fix','running','waiting_for_pr','', ?, 't','t')`,
    ).run(JSON.stringify({ branch: "m87/fix-job-1", repository: "o/r" }));
  }

  it("closes the job succeeded when the PR is detected", async () => {
    const binaryPath = await writeFakeDetectPlugin(true);
    await seed(binaryPath);
    const effects = createEffects({
      db,
      stateDir: dir,
      config: {},
      agentSpec: null,
    });
    const { events, api } = collector();
    await effects.fix_detect({ job_id: "job-1" }, api);
    const closed = events.find(
      (e) => e.entity === "job" && e.lifecycle === "closed",
    );
    expect(closed).toBeDefined();
    expect(closed.item_id).toBe("github:github:pr:o/r/5");
    expect(closed.payload.status).toBe("succeeded");
    expect(closed.payload.metadata.pr_url).toBe(
      "https://github.com/o/r/pull/5",
    );
  });

  it("keeps the job waiting when no PR is detected", async () => {
    const binaryPath = await writeFakeDetectPlugin(false);
    await seed(binaryPath);
    const effects = createEffects({
      db,
      stateDir: dir,
      config: {},
      agentSpec: null,
    });
    const { events, api } = collector();
    await effects.fix_detect({ job_id: "job-1" }, api);
    const updated = events.find(
      (e) => e.entity === "job" && e.lifecycle === "updated",
    );
    expect(updated.payload.phase).toBe("waiting_for_pr");
    expect(events.some((e) => e.lifecycle === "closed")).toBe(false);
  });

  it("advances the probe schedule on a miss (attempts + future next_check_at)", async () => {
    const binaryPath = await writeFakeDetectPlugin(false);
    await seed(binaryPath);
    db.prepare(
      "update jobs set check_attempts=2, started_at='2026-05-28T12:00:00.000Z' where id='job-1'",
    ).run();
    const effects = createEffects({
      db,
      stateDir: dir,
      config: { poll_interval: 300 },
      agentSpec: null,
    });
    const { events, api } = collector();
    await effects.fix_detect({ job_id: "job-1" }, api);
    const updated = events.find(
      (e) => e.entity === "job" && e.lifecycle === "updated",
    );
    expect(updated.payload.check_attempts).toBe(3);
    // attempt 3 of the 30s-base backoff = 240s, still under the 300s cap
    const delta = Date.parse(updated.payload.next_check_at) - Date.now();
    expect(delta).toBeGreaterThan(200_000);
    expect(delta).toBeLessThanOrEqual(240_000);
  });

  it("warns (but never gives up) when a job has waited past the threshold", async () => {
    const binaryPath = await writeFakeDetectPlugin(false);
    await seed(binaryPath);
    const longAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
    db.prepare("update jobs set started_at=? where id='job-1'").run(longAgo);
    const warnings = [];
    const effects = createEffects({
      db,
      stateDir: dir,
      config: {},
      agentSpec: null,
      logger: {
        info: () => {},
        warn: (msg, fields) => warnings.push({ msg, fields }),
        error: () => {},
      },
    });
    const { events, api } = collector();
    await effects.fix_detect({ job_id: "job-1" }, api);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].fields.waited_hours).toBeGreaterThanOrEqual(24);
    // Still waiting - no closed event; the probe rotation continues.
    const updated = events.find(
      (e) => e.entity === "job" && e.lifecycle === "updated",
    );
    expect(updated.payload.phase).toBe("waiting_for_pr");
    expect(updated.payload.metadata.pr_check_warned_at).toBeDefined();
    expect(events.some((e) => e.lifecycle === "closed")).toBe(false);

    project(db, makeEvent({ actor: "core", ...updated }));
    events.length = 0;
    await effects.fix_detect({ job_id: "job-1" }, api);

    expect(warnings).toHaveLength(1);
  });
});
