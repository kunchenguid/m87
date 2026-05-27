import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(repoRoot, "src", "cli", "index.js");

describe("e2e: init wizard command contract", () => {
  let homeDir;
  let stateDir;
  let env;

  const firstpass = (...args) =>
    execFileAsync(process.execPath, [CLI, ...args], { env });
  const parse = ({ stdout }) => yaml.load(stdout);

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "firstpass-init-"));
    stateDir = join(homeDir, ".firstpass");
    env = {
      ...process.env,
      HOME: homeDir,
      FIRSTPASS_STATE_DIR: stateDir,
      FIRSTPASS_AGENT_PROBE_PATH: "",
      FIRSTPASS_SERVICE_DRY_RUN: "1",
      FIRSTPASS_SKIP_SHELLENV: "1",
    };
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("preserves non-TTY init as the existing idempotent YAML bootstrap", async () => {
    const initialized = parse(await firstpass("init"));

    expect(initialized).toEqual({
      status: "initialized",
      state_dir: stateDir,
    });
    expect(existsSync(join(stateDir, "firstpass.sqlite"))).toBe(true);
    expect(
      yaml.load(readFileSync(join(stateDir, "config.yaml"), "utf8")),
    ).toMatchObject({
      agent: null,
      plugins: {},
    });
  });

  it("fails clearly when the wizard is forced without a TTY", async () => {
    const err = await firstpass("init", "--wizard").catch((error) => error);

    expect(err.code).toBe(2);
    expect(err.stderr).toContain("--wizard requires an interactive terminal");
  });

  it("runs headless defaults with --yes and an explicit service opt-out", async () => {
    const initialized = parse(
      await firstpass("init", "--yes", "--no-install-service"),
    );

    expect(initialized).toMatchObject({
      status: "initialized",
      mode: "headless",
      agent: { mode: "auto", target: null },
      source: { type: "skip" },
      service: { status: "skipped" },
    });
    expect(initialized.commands).toContain("firstpass");
  });

  it("can configure GitHub with flags only", async () => {
    const initialized = parse(
      await firstpass(
        "init",
        "--yes",
        "--agent",
        "acp:opencode",
        "--plugin",
        "github",
        "--github-repo",
        "kunchenguid/firstpass",
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

    const db = new Database(join(stateDir, "firstpass.sqlite"));
    try {
      const plugin = db
        .prepare("select * from plugins where id='github'")
        .get();
      expect(plugin).toBeTruthy();
      expect(JSON.parse(plugin.config_json)).toMatchObject({
        explicit_repos: ["kunchenguid/firstpass"],
      });
    } finally {
      db.close();
    }
  });

  it("treats equals-form init options as headless setup flags", async () => {
    const initialized = parse(
      await firstpass(
        "init",
        "--plugin=github",
        "--github-repo=kunchenguid/firstpass",
      ),
    );

    expect(initialized).toMatchObject({
      status: "initialized",
      mode: "headless",
      source: { type: "github", plugin: "github" },
    });

    const db = new Database(join(stateDir, "firstpass.sqlite"));
    try {
      const plugin = db
        .prepare("select * from plugins where id='github'")
        .get();
      expect(JSON.parse(plugin.config_json)).toMatchObject({
        explicit_repos: ["kunchenguid/firstpass"],
      });
    } finally {
      db.close();
    }
  });

  it("does not allow internal test plugins through setup", async () => {
    const err = await firstpass(
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
