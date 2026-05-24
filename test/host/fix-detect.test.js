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
  const dir = await mkdtemp(join(tmpdir(), "firstpass-detect-plugin-"));
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
    dir = await mkdtemp(join(tmpdir(), "firstpass-detect-"));
    db = createDatabase(join(dir, "t.sqlite"));
  });
  afterEach(() => {
    db?.close();
  });

  async function seed(binaryPath) {
    db.prepare(
      `insert into plugins (id, binary_path, binary_hash, version, protocol_version, manifest_json, config_json, status, installed_at)
       values ('github', ?, null, '2', 'firstpass.plugin.v2', '{}', '{}', 'active', 't')`,
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
    ).run(JSON.stringify({ branch: "firstpass/fix-job-1", repository: "o/r" }));
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
});
