import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const PLUGIN_PATH = "plugins/gmail/firstpass-src-gmail.js";

const CREDENTIALED_ENV = {
  ...process.env,
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gmail-credentials.json",
};

/**
 * Spawn the gmail plugin, pipe JSON to stdin, and resolve its parsed stdout.
 * @param {string[]} args
 * @param {unknown} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<any>}
 */
const runPlugin = (args, input = {}, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PLUGIN_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`bad JSON from plugin: ${err}\n${stdout}`));
        }
      } else {
        reject(new Error(`plugin exited with ${code}: ${stderr}`));
      }
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });

describe("gmail source plugin (contract v2)", () => {
  test("manifest reports protocol v2 and the gmail plugin id", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      PLUGIN_PATH,
      "manifest",
    ]);
    const manifest = JSON.parse(stdout);

    expect(manifest.protocol_version).toBe("firstpass.plugin.v2");
    expect(manifest.plugin.id).toBe("gmail");
    expect(manifest.item_types).toEqual([
      { type: "email_thread", display_name: "Email Thread" },
    ]);
    expect(manifest.action_types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "draft_reply",
          safety: "external_write",
        }),
      ]),
    );
  });

  test("sync with empty fingerprints emits created events and a baseline", async () => {
    const result = await runPlugin(
      ["sync"],
      { config: {}, fingerprints: {} },
      CREDENTIALED_ENV,
    );

    expect(result.protocol_version).toBe("firstpass.plugin.v2");
    expect(result.status).toBe("complete");
    expect(result.items).toBeUndefined();

    expect(result.events.length).toBeGreaterThanOrEqual(1);
    const created = result.events.find(
      (event) => event.external_id === "gmail:thread:thread-1",
    );
    expect(created).toBeDefined();
    expect(created.lifecycle).toBe("created");
    expect(created.item_type).toBe("email_thread");
    expect(created.payload.type).toBe("thread_received");
    expect(created.attention.should_surface).toBe(true);

    // returns the new complete fingerprint baseline
    expect(result.fingerprints).toEqual({
      "gmail:thread:thread-1": "gmail-thread-1-v1",
    });
  });

  test("re-sync with the returned baseline emits no events", async () => {
    const first = await runPlugin(
      ["sync"],
      { config: {}, fingerprints: {} },
      CREDENTIALED_ENV,
    );

    const second = await runPlugin(
      ["sync"],
      { config: {}, fingerprints: first.fingerprints },
      CREDENTIALED_ENV,
    );

    expect(second.status).toBe("complete");
    expect(second.events).toEqual([]);
    expect(second.fingerprints).toEqual(first.fingerprints);
  });

  test("sync emits an updated event when a thread fingerprint changes", async () => {
    const baseline = { "gmail:thread:thread-1": "gmail-thread-1-v0" };
    const result = await runPlugin(
      ["sync"],
      { config: {}, fingerprints: baseline },
      CREDENTIALED_ENV,
    );

    const updated = result.events.find(
      (event) => event.external_id === "gmail:thread:thread-1",
    );
    expect(updated.lifecycle).toBe("updated");
    expect(updated.payload.local_state).toBe("new");
  });

  test("sync emits a closed event when a thread disappears from the source", async () => {
    const baseline = { "gmail:thread:gone": "stale-fp" };
    const result = await runPlugin(
      ["sync"],
      { config: { threads: [] }, fingerprints: baseline },
      CREDENTIALED_ENV,
    );

    const closed = result.events.find(
      (event) => event.external_id === "gmail:thread:gone",
    );
    expect(closed.lifecycle).toBe("closed");
    expect(result.fingerprints).toEqual({});
  });

  test("sync is permission_denied without credentials and keeps the baseline", async () => {
    const env = { ...process.env };
    delete env.GOOGLE_APPLICATION_CREDENTIALS;

    const baseline = { "gmail:thread:thread-1": "gmail-thread-1-v1" };
    const result = await runPlugin(
      ["sync"],
      { config: {}, fingerprints: baseline },
      env,
    );

    expect(result.status).toBe("permission_denied");
    expect(result.events).toEqual([]);
    expect(result.fingerprints).toEqual(baseline);
  });

  test("configure flags credentials required when none are configured", async () => {
    const env = { ...process.env };
    delete env.GOOGLE_APPLICATION_CREDENTIALS;

    const result = await runPlugin(["configure"], { config: {} }, env);

    expect(result.protocol_version).toBe("firstpass.plugin.v2");
    expect(result.credentials_required).toBe(true);
    expect(result.credentials).toEqual({ required: true });
    expect(result.warnings[0]).toContain("OS credential store");
  });

  test("configure detects existing application credentials", async () => {
    const result = await runPlugin(
      ["configure"],
      { config: {} },
      CREDENTIALED_ENV,
    );

    expect(result.credentials_required).toBe(false);
    expect(result.credentials).toEqual({
      required: false,
      source: "GOOGLE_APPLICATION_CREDENTIALS",
    });
  });

  test("doctor warns when credentials are missing and is ok otherwise", async () => {
    const env = { ...process.env };
    delete env.GOOGLE_APPLICATION_CREDENTIALS;

    const missing = await runPlugin(["doctor"], {}, env);
    expect(missing.protocol_version).toBe("firstpass.plugin.v2");
    expect(missing.status).toBe("ok");
    const missingCheck = missing.checks.find(
      (check) => check.id === "gmail-credentials",
    );
    expect(missingCheck.status).toBe("warn");
    expect(missing.warnings.join(" ")).toContain("demo only");

    const present = await runPlugin(["doctor"], {}, CREDENTIALED_ENV);
    const presentCheck = present.checks.find(
      (check) => check.id === "gmail-credentials",
    );
    expect(presentCheck.status).toBe("ok");
    expect(present.warnings).toEqual([]);
  });

  test("automation workspace commands report not-supported failures", async () => {
    const prepare = await runPlugin(["prepare-automation-workspace"], {
      job: { id: "job-1" },
    });
    expect(prepare.protocol_version).toBe("firstpass.plugin.v2");
    expect(prepare.status).toBe("failed");

    const submit = await runPlugin(["submit-automation-workspace"], {
      job: { id: "job-1" },
    });
    expect(submit.status).toBe("failed");
  });

  test("rejects unsupported protocol versions", async () => {
    await expect(
      runPlugin(["configure", "--protocol-version", "firstpass.plugin.v1"], {
        config: {},
      }),
    ).rejects.toThrow(
      "unsupported protocol version: firstpass.plugin.v1; expected firstpass.plugin.v2",
    );
  });
});
