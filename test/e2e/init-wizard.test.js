import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runM87, waitFor } from "../support/e2e-harness.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(repoRoot, "src", "cli", "index.js");

describe("e2e: init wizard command contract", () => {
  let homeDir;
  let stateDir;
  let env;

  const m87 = (...args) => runM87(CLI, args, env);
  const parse = ({ stdout }) => yaml.load(stdout);

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "m87-init-"));
    stateDir = join(homeDir, ".m87");
    env = {
      ...process.env,
      HOME: homeDir,
      M87_STATE_DIR: stateDir,
      M87_AGENT_PROBE_PATH: "",
      M87_SERVICE_DRY_RUN: "1",
      M87_SKIP_SHELLENV: "1",
    };
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("preserves non-TTY init as the existing idempotent YAML bootstrap", async () => {
    const initialized = parse(await m87("init"));

    expect(initialized).toEqual({
      status: "initialized",
      state_dir: stateDir,
    });
    expect(existsSync(join(stateDir, "m87.sqlite"))).toBe(true);
    expect(
      yaml.load(readFileSync(join(stateDir, "config.yaml"), "utf8")),
    ).toMatchObject({
      agent: null,
      plugins: {},
    });
  });

  it("fails clearly when the wizard is forced without a TTY", async () => {
    const err = await m87("init", "--wizard").catch((error) => error);

    expect(err.code).toBe(2);
    expect(err.stderr).toContain("--wizard requires an interactive terminal");
  });

  it("runs headless defaults with --yes and an explicit service opt-out", async () => {
    const initialized = parse(
      await m87("init", "--yes", "--no-install-service"),
    );

    expect(initialized).toMatchObject({
      status: "initialized",
      mode: "headless",
      agent: { mode: "auto", target: null },
      source: { type: "skip" },
      service: { status: "skipped" },
    });
    expect(initialized.commands).toContain("m87");
  });

  it("can configure GitHub with flags only", async () => {
    const initialized = parse(
      await m87(
        "init",
        "--yes",
        "--agent",
        "acp:opencode",
        "--plugin",
        "github",
        "--github-repo",
        "kunchenguid/m87",
        "--no-install-service",
      ),
    );

    expect(initialized).toMatchObject({
      status: "initialized",
      mode: "headless",
      agent: { mode: "custom", target: "acp:opencode" },
      source: { type: "github", plugin: "github" },
    });
    expect(initialized.commands.join("\n")).not.toContain("mock");

    const config = yaml.load(
      readFileSync(join(stateDir, "config.yaml"), "utf8"),
    );
    expect(config.agent).toBe("acp:opencode");

    const db = new Database(join(stateDir, "m87.sqlite"));
    try {
      const plugin = db
        .prepare("select * from plugins where id='github'")
        .get();
      expect(plugin).toBeTruthy();
      expect(JSON.parse(plugin.config_json)).toMatchObject({
        explicit_repos: ["kunchenguid/m87"],
      });
    } finally {
      db.close();
    }
  });

  it("treats equals-form init options as headless setup flags", async () => {
    const initialized = parse(
      await m87("init", "--plugin=github", "--github-repo=kunchenguid/m87"),
    );

    expect(initialized).toMatchObject({
      status: "initialized",
      mode: "headless",
      source: { type: "github", plugin: "github" },
    });

    const db = new Database(join(stateDir, "m87.sqlite"));
    try {
      const plugin = db
        .prepare("select * from plugins where id='github'")
        .get();
      expect(JSON.parse(plugin.config_json)).toMatchObject({
        explicit_repos: ["kunchenguid/m87"],
      });
    } finally {
      db.close();
    }
  });

  it("starts a background daemon with --start-daemon and leaves it running", async () => {
    const result = parse(
      await m87("init", "--yes", "--no-install-service", "--start-daemon"),
    );
    expect(result.daemon).toMatchObject({ status: "started" });
    // The setup-started daemon gets the same log redirection as
    // `m87 daemon start` - its stderr is the operational record.
    expect(result.daemon.log).toBe(join(stateDir, "daemon.log"));

    // The detached daemon needs a moment to boot and advertise its pidfile;
    // once up, it keeps running after the init command returns.
    await waitFor(() => existsSync(join(stateDir, "daemon.pid")));
    const status = parse(await m87("daemon", "status"));
    expect(status.running).toBe(true);

    // Clean up the detached daemon so it does not outlive the test.
    await m87("daemon", "stop");
  }, 30000);

  it("does not allow internal test plugins through setup", async () => {
    const err = await m87(
      "init",
      "--yes",
      "--plugin",
      "mock",
      "--no-install-service",
    ).catch((error) => error);

    expect(err.code).toBe(2);
    expect(err.stderr).toContain("GitHub or skipping source setup only");
  });
});
