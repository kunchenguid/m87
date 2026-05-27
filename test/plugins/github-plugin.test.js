import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const PLUGIN_PATH = "plugins/github/firstpass-src-github.js";

/**
 * Spawn the plugin as a subprocess, write JSON to stdin, capture stdout.
 *
 * @param {string[]} args
 * @param {string} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
const runPluginWithInput = (args, input, env = process.env) =>
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
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`plugin exited with ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });

/**
 * Write a fake `gh` executable that responds to the args the plugin passes.
 * Reuses the PATH-injection approach (FIRSTPASS_GH_BIN) from the legacy test.
 *
 * @param {string[]} scriptLines
 */
async function writeFakeGh(scriptLines) {
  const tempDir = await mkdtemp(join(tmpdir(), "firstpass-gh-"));
  // .mjs so the plugin runs it under Node on every platform (Windows can't exec
  // a bare shebang script); the script body below is ESM.
  const fakeGhPath = join(tempDir, "gh.mjs");
  const callsPath = join(tempDir, "calls.jsonl");
  await writeFile(
    fakeGhPath,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
      ...scriptLines,
      'process.stderr.write(`unexpected gh args: ${args.join(" ")}`);',
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  await chmod(fakeGhPath, 0o755);
  return { fakeGhPath, callsPath };
}

/** @param {string} callsPath */
async function readGhCalls(callsPath) {
  const content = await readFile(callsPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * A fake gh that serves one open issue and one open PR for kunchenguid/firstpass.
 * `issueOverride` / `prOverride` let a test drop or change an object.
 *
 * @param {{ issues?: string, prs?: string }} [overrides]
 */
function ghScriptForFirstpassRepo(overrides = {}) {
  const issues =
    overrides.issues ??
    JSON.stringify([
      {
        number: 42,
        title: "FirstPass issue",
        author: { login: "octocat" },
        state: "OPEN",
        url: "https://github.com/kunchenguid/firstpass/issues/42",
        updatedAt: "2026-05-15T10:00:00Z",
        labels: [{ name: "needs-response" }],
        comments: 3,
      },
    ]);
  const prs =
    overrides.prs ??
    JSON.stringify([
      {
        number: 7,
        title: "FirstPass PR",
        author: { login: "reviewer" },
        state: "OPEN",
        url: "https://github.com/kunchenguid/firstpass/pull/7",
        updatedAt: "2026-05-15T11:00:00Z",
        labels: [],
        reviewDecision: "CHANGES_REQUESTED",
      },
    ]);
  return [
    'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
    'if (args[0] === "issue" && args[1] === "list") {',
    `  process.stdout.write(${JSON.stringify(issues)});`,
    "  process.exit(0);",
    "}",
    'if (args[0] === "pr" && args[1] === "list") {',
    `  process.stdout.write(${JSON.stringify(prs)});`,
    "  process.exit(0);",
    "}",
  ];
}

const syncInput = (fingerprints) =>
  `${JSON.stringify({
    account_id: "github-personal",
    fingerprints,
    config: {
      username: "kunchenguid",
      explicit_repos: ["kunchenguid/firstpass"],
    },
  })}\n`;

describe("github source plugin (contract v2)", () => {
  test("manifest reports protocol_version v2 and plugin id github", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      PLUGIN_PATH,
      "manifest",
    ]);
    const manifest = JSON.parse(stdout);

    expect(manifest.protocol_version).toBe("firstpass.plugin.v2");
    expect(manifest.plugin.id).toBe("github");
    expect(manifest.item_types.map((t) => t.type)).toEqual([
      "issue",
      "pull_request",
    ]);
    expect(manifest.action_types.map((a) => a.type)).toEqual([
      "comment",
      "close",
      "reopen",
      "review",
      "merge",
    ]);
  });

  test("accepts the --protocol-version v2 CLI arg", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      PLUGIN_PATH,
      "manifest",
      "--protocol-version",
      "firstpass.plugin.v2",
    ]);
    expect(JSON.parse(stdout).protocol_version).toBe("firstpass.plugin.v2");
  });

  test("sync with empty fingerprints emits created events and a baseline", async () => {
    const { fakeGhPath } = await writeFakeGh(ghScriptForFirstpassRepo());

    const { stdout } = await runPluginWithInput(["sync"], syncInput({}), {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const result = JSON.parse(stdout);

    expect(result.protocol_version).toBe("firstpass.plugin.v2");
    expect(result.status).toBe("complete");

    // No items[] in v2 - only events.
    expect(result.items).toBeUndefined();

    const lifecycles = result.events.map((e) => e.lifecycle);
    expect(lifecycles).toEqual(["created", "created"]);
    expect(result.events.map((e) => e.external_id).sort()).toEqual([
      "github:issue:kunchenguid/firstpass/42",
      "github:pr:kunchenguid/firstpass/7",
    ]);
    for (const event of result.events) {
      expect(event.entity).toBe("item");
      expect(typeof event.fingerprint).toBe("string");
      expect(typeof event.payload.type).toBe("string");
      expect(event.attention).toBeTypeOf("object");
    }

    // The returned baseline maps every external_id to its fingerprint.
    expect(Object.keys(result.fingerprints).sort()).toEqual([
      "github:issue:kunchenguid/firstpass/42",
      "github:pr:kunchenguid/firstpass/7",
    ]);
  });

  test("re-syncing with the returned baseline emits no events (pure diff)", async () => {
    const { fakeGhPath } = await writeFakeGh(ghScriptForFirstpassRepo());
    const env = { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath };

    const first = JSON.parse(
      (await runPluginWithInput(["sync"], syncInput({}), env)).stdout,
    );

    const second = JSON.parse(
      (await runPluginWithInput(["sync"], syncInput(first.fingerprints), env))
        .stdout,
    );

    expect(second.status).toBe("complete");
    expect(second.events).toEqual([]);
    expect(second.fingerprints).toEqual(first.fingerprints);
  });

  test("a removed object emits a closed event", async () => {
    const { fakeGhPath } = await writeFakeGh(ghScriptForFirstpassRepo());
    const env = { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath };

    const first = JSON.parse(
      (await runPluginWithInput(["sync"], syncInput({}), env)).stdout,
    );

    // Now the PR has disappeared from the live source; only the issue remains.
    const { fakeGhPath: shrunkGh } = await writeFakeGh(
      ghScriptForFirstpassRepo({ prs: "[]" }),
    );
    const shrunkEnv = { ...process.env, FIRSTPASS_GH_BIN: shrunkGh };

    const second = JSON.parse(
      (
        await runPluginWithInput(
          ["sync"],
          syncInput(first.fingerprints),
          shrunkEnv,
        )
      ).stdout,
    );

    const closed = second.events.filter((e) => e.lifecycle === "closed");
    expect(closed.map((e) => e.external_id)).toEqual([
      "github:pr:kunchenguid/firstpass/7",
    ]);
    expect(closed[0].state).toBe("closed");

    // The issue is unchanged, so no event for it; baseline drops the PR.
    expect(second.events.every((e) => e.lifecycle === "closed")).toBe(true);
    expect(Object.keys(second.fingerprints)).toEqual([
      "github:issue:kunchenguid/firstpass/42",
    ]);
  });

  test("a changed fingerprint emits an updated event with local_state new", async () => {
    const { fakeGhPath } = await writeFakeGh(ghScriptForFirstpassRepo());
    const env = { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath };
    const first = JSON.parse(
      (await runPluginWithInput(["sync"], syncInput({}), env)).stdout,
    );

    // The issue gained activity (new updatedAt / comment count).
    const { fakeGhPath: movedGh } = await writeFakeGh(
      ghScriptForFirstpassRepo({
        issues: JSON.stringify([
          {
            number: 42,
            title: "FirstPass issue",
            author: { login: "octocat" },
            state: "OPEN",
            url: "https://github.com/kunchenguid/firstpass/issues/42",
            updatedAt: "2026-05-16T10:00:00Z",
            labels: [{ name: "needs-response" }],
            comments: 5,
          },
        ]),
      }),
    );
    const movedEnv = { ...process.env, FIRSTPASS_GH_BIN: movedGh };

    const second = JSON.parse(
      (
        await runPluginWithInput(
          ["sync"],
          syncInput(first.fingerprints),
          movedEnv,
        )
      ).stdout,
    );

    const updated = second.events.filter((e) => e.lifecycle === "updated");
    expect(updated.map((e) => e.external_id)).toEqual([
      "github:issue:kunchenguid/firstpass/42",
    ]);
    expect(updated[0].payload.local_state).toBe("new");
  });

  // FU-5/FU-6: with the deep activity probe enabled, a change that is only the
  // viewer's own activity must NOT move the fingerprint (no re-triage), while
  // activity from someone else must.
  function ghScriptWithProbe({ issueComments }) {
    return [
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") {',
      `  process.stdout.write(${JSON.stringify(
        JSON.stringify([
          {
            number: 42,
            title: "FirstPass issue",
            author: { login: "octocat" },
            state: "OPEN",
            url: "https://github.com/kunchenguid/firstpass/issues/42",
            updatedAt: "2026-05-20T10:00:00Z",
            labels: [],
            comments: 9,
          },
        ]),
      )});`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "view") {',
      `  process.stdout.write(${JSON.stringify(
        JSON.stringify({
          number: 42,
          updatedAt: "2026-05-20T10:00:00Z",
          comments: issueComments,
        }),
      )});`,
      "  process.exit(0);",
      "}",
    ];
  }

  const probeSyncInput = (fingerprints) =>
    `${JSON.stringify({
      account_id: "github-personal",
      fingerprints,
      config: {
        username: "kunchenguid",
        explicit_repos: ["kunchenguid/firstpass"],
        activity_probe: true,
        activity_probe_interval: 0,
      },
    })}\n`;

  test("activity probe ignores the viewer's own comment (no re-triage)", async () => {
    const baseComment = {
      author: { login: "octocat" },
      body: "hi",
      createdAt: "2026-05-18T10:00:00Z",
    };
    const { fakeGhPath: gh1 } = await writeFakeGh(
      ghScriptWithProbe({ issueComments: [baseComment] }),
    );
    const first = JSON.parse(
      (
        await runPluginWithInput(["sync"], probeSyncInput({}), {
          ...process.env,
          FIRSTPASS_GH_BIN: gh1,
        })
      ).stdout,
    );
    expect(first.events.map((e) => e.lifecycle)).toEqual(["created"]);

    // The viewer adds their own comment: updatedAt advances but the latest
    // foreign activity does not, so the fingerprint must be unchanged.
    const { fakeGhPath: gh2 } = await writeFakeGh(
      ghScriptWithProbe({
        issueComments: [
          baseComment,
          {
            author: { login: "kunchenguid" },
            body: "my reply",
            createdAt: "2026-05-21T10:00:00Z",
          },
        ],
      }),
    );
    const second = JSON.parse(
      (
        await runPluginWithInput(["sync"], probeSyncInput(first.fingerprints), {
          ...process.env,
          FIRSTPASS_GH_BIN: gh2,
        })
      ).stdout,
    );
    expect(second.events).toEqual([]);
  });

  test("activity probe re-triages on another user's comment", async () => {
    const baseComment = {
      author: { login: "octocat" },
      body: "hi",
      createdAt: "2026-05-18T10:00:00Z",
    };
    const { fakeGhPath: gh1 } = await writeFakeGh(
      ghScriptWithProbe({ issueComments: [baseComment] }),
    );
    const first = JSON.parse(
      (
        await runPluginWithInput(["sync"], probeSyncInput({}), {
          ...process.env,
          FIRSTPASS_GH_BIN: gh1,
        })
      ).stdout,
    );

    const { fakeGhPath: gh2 } = await writeFakeGh(
      ghScriptWithProbe({
        issueComments: [
          baseComment,
          {
            author: { login: "stranger" },
            body: "what about this",
            createdAt: "2026-05-22T10:00:00Z",
          },
        ],
      }),
    );
    const second = JSON.parse(
      (
        await runPluginWithInput(["sync"], probeSyncInput(first.fingerprints), {
          ...process.env,
          FIRSTPASS_GH_BIN: gh2,
        })
      ).stdout,
    );
    expect(second.events.map((e) => e.lifecycle)).toEqual(["updated"]);
  });

  // FU-3: a self-authored maintainer item stays out of the inbox until someone
  // else engages. Drive it through the probe (which knows foreign activity).
  function ghScriptSelfAuthoredIssue({ issueComments }) {
    return [
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") {',
      `  process.stdout.write(${JSON.stringify(
        JSON.stringify([
          {
            number: 50,
            title: "My own issue",
            author: { login: "kunchenguid" },
            state: "OPEN",
            url: "https://github.com/kunchenguid/firstpass/issues/50",
            updatedAt: "2026-05-20T10:00:00Z",
            labels: [],
            comments: issueComments.length,
          },
        ]),
      )});`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "view") {',
      `  process.stdout.write(${JSON.stringify(
        JSON.stringify({ number: 50, comments: issueComments }),
      )});`,
      "  process.exit(0);",
      "}",
    ];
  }

  test("self-authored item does not surface without foreign activity", async () => {
    const { fakeGhPath } = await writeFakeGh(
      ghScriptSelfAuthoredIssue({ issueComments: [] }),
    );
    const result = JSON.parse(
      (
        await runPluginWithInput(["sync"], probeSyncInput({}), {
          ...process.env,
          FIRSTPASS_GH_BIN: fakeGhPath,
        })
      ).stdout,
    );
    const issue = result.events.find((e) =>
      e.external_id.startsWith("github:issue:"),
    );
    expect(issue.metadata.is_self_authored).toBe(true);
    expect(issue.attention.should_surface).toBe(false);
  });

  test("self-authored item surfaces once another user comments", async () => {
    const { fakeGhPath } = await writeFakeGh(
      ghScriptSelfAuthoredIssue({
        issueComments: [
          {
            author: { login: "stranger" },
            body: "ping",
            createdAt: "2026-05-22T10:00:00Z",
          },
        ],
      }),
    );
    const result = JSON.parse(
      (
        await runPluginWithInput(["sync"], probeSyncInput({}), {
          ...process.env,
          FIRSTPASS_GH_BIN: fakeGhPath,
        })
      ).stdout,
    );
    const issue = result.events.find((e) =>
      e.external_id.startsWith("github:issue:"),
    );
    expect(issue.attention.should_surface).toBe(true);
  });

  // FU-2: contributor items may only use contributor-safe actions.
  test("validate-action rejects maintainer-only actions for contributor role", async () => {
    const review = JSON.parse(
      (
        await runPluginWithInput(
          ["validate-action"],
          `${JSON.stringify({
            item_external_id: "github:pr:upstream/project/5",
            role: "contributor",
            action: {
              id: "r1",
              action_type: "review",
              params: { event: "APPROVE", body: "lgtm" },
            },
          })}\n`,
        )
      ).stdout,
    );
    expect(review.valid).toBe(false);
    expect(review.warnings.join(" ")).toMatch(/contributor/i);

    const comment = JSON.parse(
      (
        await runPluginWithInput(
          ["validate-action"],
          `${JSON.stringify({
            item_external_id: "github:pr:upstream/project/5",
            role: "contributor",
            action: {
              id: "c1",
              action_type: "comment",
              params: { body: "thanks" },
            },
          })}\n`,
        )
      ).stdout,
    );
    expect(comment.valid).toBe(true);
  });

  test("execute-action refuses a maintainer-only action for a contributor item", async () => {
    const { stdout } = await runPluginWithInput(
      ["execute-action"],
      `${JSON.stringify({
        item_external_id: "github:pr:upstream/project/5",
        approval_id: "approval-9",
        role: "contributor",
        action: {
          id: "m1",
          action_type: "review",
          params: { event: "APPROVE", body: "lgtm" },
        },
      })}\n`,
    );
    const result = JSON.parse(stdout);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/contributor/i);
  });

  test("maps gh rate-limit failures to rate_limited without dropping the baseline", async () => {
    const { fakeGhPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") { process.stderr.write("API rate limit exceeded"); process.exit(1); }',
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
    ]);
    const baseline = { "github:issue:kunchenguid/firstpass/42": "abc" };

    const { stdout } = await runPluginWithInput(["sync"], syncInput(baseline), {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const result = JSON.parse(stdout);

    expect(result.status).toBe("rate_limited");
    expect(result.retry_after_seconds).toBe(300);
    expect(result.events).toEqual([]);
    expect(result.fingerprints).toEqual(baseline);
  });

  // FU-9: repo discovery conditions.
  function ghScriptForRepoConditions({ ownedRepos, starred = [] }) {
    return [
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "repo" && args[1] === "list") {',
      `  process.stdout.write(${JSON.stringify(JSON.stringify(ownedRepos))});`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "api" && args[1] === "user/starred") {',
      `  process.stdout.write(${JSON.stringify(starred.join("\n"))});`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "issue" && args[1] === "list") {',
      "  const repoIdx = args.indexOf('--repo');",
      "  const repo = args[repoIdx + 1];",
      "  process.stdout.write(JSON.stringify([{ number: 1, title: repo + ' issue', author: { login: 'octocat' }, state: 'OPEN', url: 'u', updatedAt: '2026-05-15T10:00:00Z', labels: [], comments: 0 }]));",
      "  process.exit(0);",
      "}",
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
    ];
  }

  const conditionSyncInput = (repoConditions) =>
    `${JSON.stringify({
      account_id: "github-personal",
      fingerprints: {},
      config: { username: "kunchenguid", repo_conditions: repoConditions },
    })}\n`;

  test("all_public_owned discovers only public owned repos", async () => {
    const { fakeGhPath } = await writeFakeGh(
      ghScriptForRepoConditions({
        ownedRepos: [
          {
            nameWithOwner: "kunchenguid/pub",
            isArchived: false,
            visibility: "PUBLIC",
          },
          {
            nameWithOwner: "kunchenguid/priv",
            isArchived: false,
            visibility: "PRIVATE",
          },
          {
            nameWithOwner: "kunchenguid/old",
            isArchived: true,
            visibility: "PUBLIC",
          },
        ],
      }),
    );
    const { stdout } = await runPluginWithInput(
      ["sync"],
      conditionSyncInput(["all_public_owned"]),
      { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath },
    );
    const result = JSON.parse(stdout);
    const repos = result.events
      .map((e) => e.external_id)
      .filter((id) => id.startsWith("github:issue:"));
    expect(repos).toEqual(["github:issue:kunchenguid/pub/1"]);
  });

  test("all_public_owned_and_starred intersects owned with starred", async () => {
    const { fakeGhPath } = await writeFakeGh(
      ghScriptForRepoConditions({
        ownedRepos: [
          {
            nameWithOwner: "kunchenguid/a",
            isArchived: false,
            visibility: "PUBLIC",
          },
          {
            nameWithOwner: "kunchenguid/b",
            isArchived: false,
            visibility: "PUBLIC",
          },
        ],
        starred: ["kunchenguid/b", "someoneelse/c"],
      }),
    );
    const { stdout } = await runPluginWithInput(
      ["sync"],
      conditionSyncInput(["all_public_owned_and_starred"]),
      { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath },
    );
    const result = JSON.parse(stdout);
    const ids = result.events
      .map((e) => e.external_id)
      .filter((id) => id.startsWith("github:issue:"));
    expect(ids).toEqual(["github:issue:kunchenguid/b/1"]);
  });

  // FU-10: draft / WIP filtering.
  test("exclude_drafts drops draft PRs and exclude_wip drops WIP-titled items", async () => {
    const { fakeGhPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") {',
      `  process.stdout.write(${JSON.stringify(
        JSON.stringify([
          {
            number: 42,
            title: "WIP: refactor loop",
            author: { login: "octocat" },
            state: "OPEN",
            url: "u",
            updatedAt: "2026-05-15T10:00:00Z",
            labels: [],
            comments: 0,
          },
          {
            number: 43,
            title: "Real bug report",
            author: { login: "octocat" },
            state: "OPEN",
            url: "u",
            updatedAt: "2026-05-15T10:00:00Z",
            labels: [],
            comments: 0,
          },
        ]),
      )});`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "pr" && args[1] === "list") {',
      `  process.stdout.write(${JSON.stringify(
        JSON.stringify([
          {
            number: 7,
            title: "Draft work",
            author: { login: "reviewer" },
            state: "OPEN",
            url: "u",
            updatedAt: "2026-05-15T11:00:00Z",
            labels: [],
            reviewDecision: "",
            isDraft: true,
          },
          {
            number: 8,
            title: "Ready PR",
            author: { login: "reviewer" },
            state: "OPEN",
            url: "u",
            updatedAt: "2026-05-15T11:00:00Z",
            labels: [],
            reviewDecision: "",
            isDraft: false,
          },
        ]),
      )});`,
      "  process.exit(0);",
      "}",
    ]);

    const input = `${JSON.stringify({
      account_id: "github-personal",
      fingerprints: {},
      config: {
        username: "kunchenguid",
        explicit_repos: ["kunchenguid/firstpass"],
        exclude_drafts: true,
        exclude_wip: true,
      },
    })}\n`;

    const { stdout } = await runPluginWithInput(["sync"], input, {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const ids = JSON.parse(stdout)
      .events.map((e) => e.external_id)
      .sort();
    expect(ids).toEqual([
      "github:issue:kunchenguid/firstpass/43",
      "github:pr:kunchenguid/firstpass/8",
    ]);
  });

  // FU-12: ignore_older_than skips items whose latest activity is too old.
  test("ignore_older_than drops items older than the threshold", async () => {
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    const fresh = new Date(Date.now() - 2 * 86400000).toISOString();
    const { fakeGhPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") {',
      `  process.stdout.write(JSON.stringify([`,
      `    { number: 1, title: "old", author: { login: "octocat" }, state: "OPEN", url: "u", updatedAt: ${JSON.stringify(old)}, labels: [], comments: 0 },`,
      `    { number: 2, title: "fresh", author: { login: "octocat" }, state: "OPEN", url: "u", updatedAt: ${JSON.stringify(fresh)}, labels: [], comments: 0 }`,
      `  ]));`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
    ]);
    const input = `${JSON.stringify({
      account_id: "github-personal",
      fingerprints: {},
      config: {
        username: "kunchenguid",
        explicit_repos: ["kunchenguid/firstpass"],
        ignore_older_than: "365d",
      },
    })}\n`;
    const { stdout } = await runPluginWithInput(["sync"], input, {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const ids = JSON.parse(stdout).events.map((e) => e.external_id);
    expect(ids).toEqual(["github:issue:kunchenguid/firstpass/2"]);
  });

  // FU-11: stale_threshold marks long-idle open items with a local stale flag.
  test("stale_threshold flags long-idle items and leaves fresh ones unflagged", async () => {
    const stale = new Date(Date.now() - 60 * 86400000).toISOString();
    const fresh = new Date(Date.now() - 1 * 86400000).toISOString();
    const { fakeGhPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") {',
      `  process.stdout.write(JSON.stringify([`,
      `    { number: 1, title: "idle", author: { login: "octocat" }, state: "OPEN", url: "u", updatedAt: ${JSON.stringify(stale)}, labels: [], comments: 0 },`,
      `    { number: 2, title: "active", author: { login: "octocat" }, state: "OPEN", url: "u", updatedAt: ${JSON.stringify(fresh)}, labels: [], comments: 0 }`,
      `  ]));`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
    ]);
    const input = `${JSON.stringify({
      account_id: "github-personal",
      fingerprints: {},
      config: {
        username: "kunchenguid",
        explicit_repos: ["kunchenguid/firstpass"],
        stale_threshold: "30d",
      },
    })}\n`;
    const { stdout } = await runPluginWithInput(["sync"], input, {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const events = JSON.parse(stdout).events;
    const idle = events.find((e) => e.external_id.endsWith("/1"));
    const active = events.find((e) => e.external_id.endsWith("/2"));
    expect(idle.metadata.stale).toBe(true);
    expect(active.metadata.stale).toBe(false);
  });

  test("parses a Retry-After value from the rate-limit error", async () => {
    const { fakeGhPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") { process.stderr.write("API rate limit exceeded. Retry-After: 90"); process.exit(1); }',
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
    ]);
    const { stdout } = await runPluginWithInput(["sync"], syncInput({}), {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const result = JSON.parse(stdout);
    expect(result.status).toBe("rate_limited");
    expect(result.retry_after_seconds).toBe(90);
  });

  test('parses a "try again in N seconds" secondary rate-limit message', async () => {
    const { fakeGhPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") { process.stderr.write("You have exceeded a secondary rate limit. Please try again in 42 seconds."); process.exit(1); }',
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
    ]);
    const { stdout } = await runPluginWithInput(["sync"], syncInput({}), {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const result = JSON.parse(stdout);
    expect(result.status).toBe("rate_limited");
    expect(result.retry_after_seconds).toBe(42);
  });

  test("reports missing gh as permission_denied", async () => {
    const { stdout } = await runPluginWithInput(["sync"], syncInput({}), {
      ...process.env,
      FIRSTPASS_GH_BIN: "/missing/gh",
    });
    const result = JSON.parse(stdout);

    expect(result.status).toBe("permission_denied");
    expect(result.warnings[0]).toContain("gh");
  });

  test("validate-action maps close to destructive and review to external_write", async () => {
    const review = JSON.parse(
      (
        await runPluginWithInput(
          ["validate-action"],
          `${JSON.stringify({
            item_external_id: "github:pr:kunchenguid/firstpass/7",
            action: {
              id: "r1",
              action_type: "review",
              params: { event: "APPROVE", body: "Looks good." },
            },
          })}\n`,
        )
      ).stdout,
    );
    const close = JSON.parse(
      (
        await runPluginWithInput(
          ["validate-action"],
          `${JSON.stringify({
            item_external_id: "github:issue:kunchenguid/firstpass/42",
            action: { id: "c1", action_type: "close", params: {} },
          })}\n`,
        )
      ).stdout,
    );

    expect(review.protocol_version).toBe("firstpass.plugin.v2");
    expect(review).toMatchObject({ valid: true, safety: "external_write" });
    expect(close).toMatchObject({ valid: true, safety: "destructive" });
  });

  test("sync stamps maintainer role + viewer identity on configured-repo items", async () => {
    const { fakeGhPath } = await writeFakeGh(ghScriptForFirstpassRepo());

    const { stdout } = await runPluginWithInput(["sync"], syncInput({}), {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const result = JSON.parse(stdout);

    for (const event of result.events) {
      expect(event.metadata).toBeTypeOf("object");
      expect(event.metadata.role).toBe("maintainer");
      expect(event.metadata.viewer).toBe("kunchenguid");
      expect(typeof event.metadata.is_self_authored).toBe("boolean");
    }
    // octocat / reviewer authored these, not the viewer.
    expect(
      result.events.every((e) => e.metadata.is_self_authored === false),
    ).toBe(true);
  });

  test("sync stamps a display_handle of repo + ref on items", async () => {
    const { fakeGhPath } = await writeFakeGh(ghScriptForFirstpassRepo());

    const { stdout } = await runPluginWithInput(["sync"], syncInput({}), {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const result = JSON.parse(stdout);

    expect(result.events.length).toBeGreaterThan(0);
    for (const event of result.events) {
      // The plugin owns its source label; core just renders the string. It
      // names the repo and the ref so the inbox is scannable by repo.
      expect(event.metadata.display_handle).toMatch(
        /^kunchenguid\/firstpass · (PR|issue) #\d+$/,
      );
    }
  });

  test("sync marks a self-authored PR as is_self_authored", async () => {
    const { fakeGhPath } = await writeFakeGh(
      ghScriptForFirstpassRepo({
        prs: JSON.stringify([
          {
            number: 9,
            title: "My own PR",
            author: { login: "kunchenguid" },
            state: "OPEN",
            url: "https://github.com/kunchenguid/firstpass/pull/9",
            updatedAt: "2026-05-15T11:00:00Z",
            labels: [],
            reviewDecision: "",
          },
        ]),
      }),
    );

    const { stdout } = await runPluginWithInput(["sync"], syncInput({}), {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const result = JSON.parse(stdout);
    const pr = result.events.find((e) =>
      e.external_id.startsWith("github:pr:"),
    );
    expect(pr.metadata.is_self_authored).toBe(true);
    expect(pr.metadata.role).toBe("maintainer");
  });

  test("sync stamps contributor role on authored_external items", async () => {
    const { fakeGhPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
      'if (args[0] === "search" && args[1] === "prs") {',
      `  process.stdout.write(${JSON.stringify(
        JSON.stringify([
          {
            repository: { nameWithOwner: "upstream/project" },
            number: 5,
            title: "My contribution",
            author: { login: "kunchenguid" },
            state: "OPEN",
            url: "https://github.com/upstream/project/pull/5",
            updatedAt: "2026-05-15T12:00:00Z",
            labels: [],
          },
        ]),
      )});`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "search" && args[1] === "issues") { process.stdout.write("[]"); process.exit(0); }',
    ]);

    const input = `${JSON.stringify({
      account_id: "github-personal",
      fingerprints: {},
      config: {
        username: "kunchenguid",
        explicit_repos: ["kunchenguid/firstpass"],
        authored_external: true,
      },
    })}\n`;

    const { stdout } = await runPluginWithInput(["sync"], input, {
      ...process.env,
      FIRSTPASS_GH_BIN: fakeGhPath,
    });
    const result = JSON.parse(stdout);
    const contrib = result.events.find((e) =>
      e.external_id.startsWith("github:pr:upstream/project"),
    );
    expect(contrib).toBeDefined();
    expect(contrib.metadata.role).toBe("contributor");
    expect(contrib.metadata.is_self_authored).toBe(true);
  });

  // FU-7: merge action with merge_method + fallback.
  test("manifest declares a merge action that is destructive", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      PLUGIN_PATH,
      "manifest",
    ]);
    const manifest = JSON.parse(stdout);
    const merge = manifest.action_types.find((a) => a.type === "merge");
    expect(merge).toBeDefined();
    expect(merge.safety).toBe("destructive");
  });

  test("validate-action accepts merge on a PR and rejects it on an issue", async () => {
    const pr = JSON.parse(
      (
        await runPluginWithInput(
          ["validate-action"],
          `${JSON.stringify({
            item_external_id: "github:pr:kunchenguid/firstpass/7",
            action: {
              id: "m1",
              action_type: "merge",
              params: { method: "squash" },
            },
          })}\n`,
        )
      ).stdout,
    );
    expect(pr).toMatchObject({ valid: true, safety: "destructive" });

    const issue = JSON.parse(
      (
        await runPluginWithInput(
          ["validate-action"],
          `${JSON.stringify({
            item_external_id: "github:issue:kunchenguid/firstpass/42",
            action: { id: "m1", action_type: "merge", params: {} },
          })}\n`,
        )
      ).stdout,
    );
    expect(issue.valid).toBe(false);
  });

  test("execute-action merges a PR with the requested method", async () => {
    const { fakeGhPath, callsPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "merge") { process.exit(0); }',
    ]);
    const { stdout } = await runPluginWithInput(
      ["execute-action"],
      `${JSON.stringify({
        item_external_id: "github:pr:kunchenguid/firstpass/7",
        approval_id: "approval-7",
        action: {
          id: "m1",
          action_type: "merge",
          params: { method: "squash" },
        },
      })}\n`,
      { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath },
    );
    expect(JSON.parse(stdout).status).toBe("succeeded");
    expect(await readGhCalls(callsPath)).toContainEqual([
      "pr",
      "merge",
      "7",
      "--repo",
      "kunchenguid/firstpass",
      "--squash",
    ]);
  });

  test("execute-action merge falls back to a repo-allowed method", async () => {
    const { fakeGhPath, callsPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "merge" && args.includes("--rebase")) { process.stderr.write("Rebase merges are not allowed"); process.exit(1); }',
      'if (args[0] === "repo" && args[1] === "view") { process.stdout.write(JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: false })); process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "merge" && args.includes("--merge")) { process.exit(0); }',
    ]);
    const { stdout } = await runPluginWithInput(
      ["execute-action"],
      `${JSON.stringify({
        item_external_id: "github:pr:kunchenguid/firstpass/7",
        approval_id: "approval-7",
        action: {
          id: "m1",
          action_type: "merge",
          params: { method: "rebase" },
        },
      })}\n`,
      { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath },
    );
    const result = JSON.parse(stdout);
    expect(result.status).toBe("succeeded");
    expect(result.external_result.merge_method).toBe("merge");
    const calls = await readGhCalls(callsPath);
    expect(calls.some((c) => c.includes("--rebase"))).toBe(true);
    expect(calls.some((c) => c.includes("--merge"))).toBe(true);
  });

  // FU-13: configurable fix PR-create modes.
  async function writeWorkspaceWithChange() {
    const ws = await mkdtemp(join(tmpdir(), "firstpass-fix-ws-"));
    await execFileAsync("git", ["init", "-q"], { cwd: ws });
    await execFileAsync("git", ["config", "user.email", "t@t.dev"], {
      cwd: ws,
    });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: ws });
    await execFileAsync(
      "git",
      ["checkout", "-q", "-b", "firstpass/fix-job-1"],
      {
        cwd: ws,
      },
    );
    await writeFile(join(ws, "change.txt"), "edited");
    return ws;
  }

  test("submit with fix_pr_create=disabled pushes a branch without a PR", async () => {
    const ws = await writeWorkspaceWithChange();
    const { fakeGhPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
    ]);
    // Fake the remote push by pointing origin at a bare repo.
    const bare = await mkdtemp(join(tmpdir(), "firstpass-fix-remote-"));
    await execFileAsync("git", ["init", "-q", "--bare"], { cwd: bare });
    await execFileAsync("git", ["remote", "add", "origin", bare], { cwd: ws });

    const { stdout } = await runPluginWithInput(
      ["submit-automation-workspace"],
      `${JSON.stringify({
        job: {
          id: "job-1",
          item_external_id: "github:pr:kunchenguid/firstpass/7",
          role: "maintainer",
        },
        workspace_path: ws,
        config: { fix_pr_create: "disabled" },
      })}\n`,
      { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath },
    );
    const result = JSON.parse(stdout);
    expect(result.status).toBe("submitted");
    expect(result.pr_url).toBeUndefined();
  });

  test("submit with fix_pr_create=gh opens a draft PR", async () => {
    const ws = await writeWorkspaceWithChange();
    const bare = await mkdtemp(join(tmpdir(), "firstpass-fix-remote-"));
    await execFileAsync("git", ["init", "-q", "--bare"], { cwd: bare });
    await execFileAsync("git", ["remote", "add", "origin", bare], { cwd: ws });
    const { fakeGhPath, callsPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "create") { process.stdout.write("https://github.com/kunchenguid/firstpass/pull/99"); process.exit(0); }',
    ]);
    const { stdout } = await runPluginWithInput(
      ["submit-automation-workspace"],
      `${JSON.stringify({
        job: {
          id: "job-1",
          item_external_id: "github:pr:kunchenguid/firstpass/7",
          role: "maintainer",
        },
        workspace_path: ws,
        config: { fix_pr_create: "gh" },
      })}\n`,
      { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath },
    );
    const result = JSON.parse(stdout);
    expect(result.status).toBe("submitted");
    expect(result.pr_url).toBe(
      "https://github.com/kunchenguid/firstpass/pull/99",
    );
    const calls = await readGhCalls(callsPath);
    expect(
      calls.some(
        (c) => c[0] === "pr" && c[1] === "create" && c.includes("--draft"),
      ),
    ).toBe(true);
  });

  // FU-15: when PR detection misses, the job waits and can be re-attached.
  test("detect-automation-pr returns waiting_for_pr then submitted", async () => {
    const { fakeGhPath: missGh } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }',
    ]);
    const miss = JSON.parse(
      (
        await runPluginWithInput(
          ["detect-automation-pr"],
          `${JSON.stringify({ repository: "kunchenguid/firstpass", branch: "firstpass/fix-job-1" })}\n`,
          { ...process.env, FIRSTPASS_GH_BIN: missGh },
        )
      ).stdout,
    );
    expect(miss.status).toBe("waiting_for_pr");

    const { fakeGhPath: hitGh } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write(JSON.stringify([{ url: "https://github.com/kunchenguid/firstpass/pull/77" }])); process.exit(0); }',
    ]);
    const hit = JSON.parse(
      (
        await runPluginWithInput(
          ["detect-automation-pr"],
          `${JSON.stringify({ repository: "kunchenguid/firstpass", branch: "firstpass/fix-job-1" })}\n`,
          { ...process.env, FIRSTPASS_GH_BIN: hitGh },
        )
      ).stdout,
    );
    expect(hit.status).toBe("submitted");
    expect(hit.pr_url).toBe("https://github.com/kunchenguid/firstpass/pull/77");
  });

  test("execute-action posts an approved comment through gh", async () => {
    const { fakeGhPath, callsPath } = await writeFakeGh([
      'if (args[0] === "auth" && args[1] === "status") { process.exit(0); }',
      'if (args[0] === "issue" && args[1] === "comment") { process.stdout.write("https://github.com/kunchenguid/firstpass/issues/42#issuecomment-1"); process.exit(0); }',
    ]);

    const { stdout } = await runPluginWithInput(
      ["execute-action"],
      `${JSON.stringify({
        item_external_id: "github:issue:kunchenguid/firstpass/42",
        approval_id: "approval-1",
        idempotency_key: "approval-1:c1",
        action: {
          id: "c1",
          action_type: "comment",
          params: { body: "Thanks." },
        },
      })}\n`,
      { ...process.env, FIRSTPASS_GH_BIN: fakeGhPath },
    );
    const result = JSON.parse(stdout);

    expect(result.protocol_version).toBe("firstpass.plugin.v2");
    expect(result.status).toBe("succeeded");
    expect(await readGhCalls(callsPath)).toContainEqual([
      "issue",
      "comment",
      "42",
      "--repo",
      "kunchenguid/firstpass",
      "--body",
      "Thanks.",
    ]);
  });
});
