import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import pkg from "../../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(repoRoot, "src", "cli", "index.js");

// A real `npm install -g` exposes the CLI as a bin SYMLINK
// (…/bin/firstpass -> …/node_modules/firstpass/dist/cli.js). When invoked that way,
// process.argv[1] is the symlink path while import.meta.url resolves to the real
// file, so the "am I the main module?" guard must compare resolved paths or the
// CLI silently does nothing. This guards that real-user invocation path.
describe("e2e: CLI entry point runs when invoked through a bin symlink", () => {
  let dir;
  let link;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-bin-"));
    link = join(dir, "firstpass");
    symlinkSync(CLI, link);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--version prints the version when run via a symlinked bin", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      link,
      "--version",
    ]);
    expect(stdout.trim()).toBe(pkg.version);
  });
});
