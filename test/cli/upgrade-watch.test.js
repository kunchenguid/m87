import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createUpgradeWatcher,
  findInstalledPackageJson,
  readPackageVersion,
} from "../../src/cli/upgrade-watch.js";

const NAME = "@kunchenguid/m87";

describe("cli/upgrade-watch", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "m87-upgrade-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writePkg = (dir, fields) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(fields));
  };

  describe("findInstalledPackageJson", () => {
    it("walks up past unrelated package.json files to the matching one", () => {
      // Layout mirrors a real install: the entry sits levels below the
      // package root, with a foreign package.json in between.
      writePkg(root, { name: NAME, version: "1.0.0" });
      writePkg(join(root, "dist"), { name: "someone-else", version: "9.9.9" });
      const entry = join(root, "dist", "cli", "index.js");
      mkdirSync(join(root, "dist", "cli"), { recursive: true });

      expect(findInstalledPackageJson(entry, NAME)).toBe(
        join(root, "package.json"),
      );
    });

    it("returns null when no matching package.json exists", () => {
      const entry = join(root, "a", "b", "entry.js");
      mkdirSync(join(root, "a", "b"), { recursive: true });
      expect(findInstalledPackageJson(entry, NAME)).toBe(null);
    });
  });

  describe("readPackageVersion", () => {
    it("reads the version for the matching package", () => {
      writePkg(root, { name: NAME, version: "1.2.3" });
      expect(readPackageVersion(join(root, "package.json"), NAME)).toBe(
        "1.2.3",
      );
    });

    it("returns null for a missing, half-written, or foreign file", () => {
      expect(readPackageVersion(join(root, "package.json"), NAME)).toBe(null);
      writeFileSync(join(root, "package.json"), '{"name": "@kunchengu');
      expect(readPackageVersion(join(root, "package.json"), NAME)).toBe(null);
      writePkg(root, { name: "other", version: "1.2.3" });
      expect(readPackageVersion(join(root, "package.json"), NAME)).toBe(null);
    });
  });

  describe("createUpgradeWatcher", () => {
    const makeWatcher = (intervalMs = 100) => {
      writePkg(root, { name: NAME, version: "1.0.0" });
      return createUpgradeWatcher({
        entryPath: join(root, "dist", "cli.js"),
        name: NAME,
        currentVersion: "1.0.0",
        intervalMs,
      });
    };

    it("confirms an upgrade only on two consecutive matching probes", () => {
      const watcher = makeWatcher();
      expect(watcher.check(100)).toBe(null); // still on 1.0.0

      writePkg(root, { name: NAME, version: "2.0.0" });
      expect(watcher.check(200)).toBe(null); // first sighting: not yet
      expect(watcher.check(300)).toBe("2.0.0"); // second sighting: confirmed
    });

    it("probes at most once per interval", () => {
      const watcher = makeWatcher(100);
      writePkg(root, { name: NAME, version: "2.0.0" });
      expect(watcher.check(100)).toBe(null);
      // Within the interval nothing is read, so the pending sighting cannot
      // be confirmed yet.
      expect(watcher.check(150)).toBe(null);
      expect(watcher.check(200)).toBe("2.0.0");
    });

    it("resets when the version settles back to the running one", () => {
      const watcher = makeWatcher();
      writePkg(root, { name: NAME, version: "2.0.0" });
      expect(watcher.check(100)).toBe(null);
      // The second read sees the running version again (e.g. a reinstall of
      // the same release landed): the pending sighting is discarded.
      writePkg(root, { name: NAME, version: "1.0.0" });
      expect(watcher.check(200)).toBe(null);
      writePkg(root, { name: NAME, version: "2.0.0" });
      expect(watcher.check(300)).toBe(null);
      expect(watcher.check(400)).toBe("2.0.0");
    });

    it("treats an unreadable probe as no change", () => {
      const watcher = makeWatcher();
      writePkg(root, { name: NAME, version: "2.0.0" });
      expect(watcher.check(100)).toBe(null);
      // Mid-install the file can vanish or be half-written; that must not
      // count as confirmation.
      writeFileSync(join(root, "package.json"), "{");
      expect(watcher.check(200)).toBe(null);
      writePkg(root, { name: NAME, version: "2.0.0" });
      expect(watcher.check(300)).toBe(null);
      expect(watcher.check(400)).toBe("2.0.0");
    });

    it("reports a null probe path when the package cannot be located", () => {
      const watcher = createUpgradeWatcher({
        entryPath: join(root, "nowhere", "cli.js"),
        name: NAME,
        currentVersion: "1.0.0",
        intervalMs: 100,
      });
      expect(watcher.probePath).toBe(null);
      expect(watcher.check(100)).toBe(null);
    });
  });
});
