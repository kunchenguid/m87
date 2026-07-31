import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

/**
 * Derive the exact release-please output set from config + workflow inputs.
 * Keep this aligned with the fleet audit rule in firstmate's release-please CI
 * report: node -> package.json (+ package-lock.json if present), changelog,
 * extra-files, and the manifest path.
 */
function expectedReleaseOutputs() {
  const config = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf8"),
  );
  const pkg = config.packages?.["."] ?? {};
  const releaseType = pkg["release-type"] ?? config["release-type"] ?? "node";
  const changelog =
    pkg["changelog-path"] ?? config["changelog-path"] ?? "CHANGELOG.md";

  const expected = [changelog];
  switch (releaseType) {
    case "simple":
      expected.push(
        pkg["version-file"] ?? config["version-file"] ?? "version.txt",
      );
      break;
    case "node":
      expected.push("package.json");
      if (existsSync(join(root, "package-lock.json"))) {
        expected.push("package-lock.json");
      }
      break;
    case "go":
      break;
    default:
      throw new Error(
        `unsupported release-please release-type for ignore derivation: ${releaseType}`,
      );
  }

  const extra = pkg["extra-files"] ?? config["extra-files"] ?? [];
  for (const entry of extra) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (path) expected.push(path);
  }

  let manifest = ".release-please-manifest.json";
  const releaseWorkflow = readFileSync(
    join(workflowsDir, "release-please.yml"),
    "utf8",
  );
  const manifestMatch = releaseWorkflow.match(/manifest-file:\s*(\S+)/);
  if (manifestMatch) manifest = manifestMatch[1];
  expected.push(manifest);

  return [...new Set(expected)];
}

function loadWorkflowOn(filePath) {
  const doc = yaml.load(readFileSync(filePath, "utf8"));
  // PyYAML/js-yaml may parse a bare `on:` key as boolean true.
  return doc?.on ?? doc?.true ?? null;
}

function pullRequestFilterCoverage(pr) {
  if (pr == null || pr === null) {
    return { kind: "unfiltered" };
  }
  if (typeof pr !== "object" || Array.isArray(pr)) {
    // `pull_request:` bare form means no path filter.
    return { kind: "unfiltered" };
  }

  if (Array.isArray(pr["paths-ignore"])) {
    return { kind: "paths-ignore", paths: pr["paths-ignore"].map(String) };
  }

  if (Array.isArray(pr.paths)) {
    return { kind: "paths", paths: pr.paths.map(String) };
  }

  return { kind: "unfiltered" };
}

function isCovered(filter, releasePath) {
  if (filter.kind === "unfiltered") return false;

  if (filter.kind === "paths-ignore") {
    return filter.paths.includes(releasePath);
  }

  // paths allow-list: a release path is "covered" (will not create a run on its
  // own) when no positive pattern matches it, or a later negation excludes it.
  let matched = false;
  for (const pattern of filter.paths) {
    if (pattern.startsWith("!")) {
      const negated = pattern.slice(1);
      if (
        matched &&
        (negated === releasePath || globMatch(negated, releasePath))
      ) {
        matched = false;
      }
      continue;
    }
    if (pattern === releasePath || globMatch(pattern, releasePath)) {
      matched = true;
    }
  }
  // Covered means the path does NOT cause the workflow to run.
  return !matched;
}

function globMatch(pattern, path) {
  // Minimal support for the `**` / `*` patterns used in workflow path filters.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

describe("release-please CI exclusions", () => {
  const expected = expectedReleaseOutputs();

  it("derives the node release-output set for this repository", () => {
    expect(expected).toEqual([
      "CHANGELOG.md",
      "package.json",
      ".release-please-manifest.json",
    ]);
  });

  it("every pull_request workflow ignores the full release-output set", () => {
    const files = readdirSync(workflowsDir).filter((name) =>
      name.endsWith(".yml"),
    );
    const prWorkflows = [];

    for (const name of files) {
      const filePath = join(workflowsDir, name);
      const on = loadWorkflowOn(filePath);
      if (!on || typeof on !== "object" || !("pull_request" in on)) continue;
      prWorkflows.push({
        name,
        filter: pullRequestFilterCoverage(on.pull_request),
      });
    }

    expect(prWorkflows.map((w) => w.name).sort()).toEqual([
      "ci.yml",
      "guard-generated-files.yml",
      "no-mistakes-required.yml",
    ]);

    const failures = [];
    for (const { name, filter } of prWorkflows) {
      const missing = expected.filter((path) => !isCovered(filter, path));
      if (missing.length > 0) {
        failures.push(`${name} missing coverage for: ${missing.join(", ")}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not attach path filters to non-pull_request triggers on ci.yml", () => {
    const on = loadWorkflowOn(join(workflowsDir, "ci.yml"));
    expect(on.push).toEqual({ branches: ["main"] });
    expect(on.pull_request.branches).toEqual(["main"]);
    expect(on.pull_request["paths-ignore"]).toEqual([
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package.json",
    ]);
    expect(on.release).toBeUndefined();
    expect(on.workflow_dispatch).toBeUndefined();
  });
});
