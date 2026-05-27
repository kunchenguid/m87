import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { startInteractiveTui } from "../../src/tui/app.js";

// Minimal TTY doubles so Ink mounts and accepts keypresses without a real
// terminal. Ink batches frames and flushes the final one on unmount when CI is
// set, so we assert on the accumulated stdout after teardown.
class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  data = "";
  write(chunk) {
    this.data += chunk;
    return true;
  }
}

// Ink reads input by listening for `readable` and draining `stdin.read()`, so
// the double queues chunks and signals readability the same way.
class FakeStdin extends EventEmitter {
  isTTY = true;
  queue = [];
  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  ref() {}
  unref() {}
  resume() {}
  pause() {}
  read() {
    return this.queue.shift() ?? null;
  }
  type(str) {
    this.queue.push(str);
    this.emit("readable");
  }
}

async function mountAndType(db, keys) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const { instance, restore } = startInteractiveTui({
    db,
    agentTarget: "acp:claude",
    daemonPid: () => 0, // offline so the info screen shows remediation
    stdout: /** @type {any} */ (stdout),
    stdin: /** @type {any} */ (stdin),
  });
  await sleep(30);
  for (const k of keys) {
    stdin.type(k);
    // Escape is held briefly by Ink's parser to disambiguate escape sequences,
    // so give it time to flush before the next key or teardown.
    await sleep(k === "\x1b" ? 120 : 40);
  }
  instance.unmount();
  await instance.waitUntilExit();
  restore();
  return stdout.data;
}

describe("tui info screen toggle", () => {
  let dir;
  let db;
  let priorCi;
  beforeEach(() => {
    priorCi = process.env.CI;
    process.env.CI = "true";
    dir = mkdtempSync(join(tmpdir(), "firstpass-info-"));
    db = createDatabase(join(dir, "t.sqlite"));
  });
  afterEach(() => {
    if (priorCi === undefined) delete process.env.CI;
    else process.env.CI = priorCi;
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not show queue counts on the inbox screen", async () => {
    const out = await mountAndType(db, []);
    expect(out).toContain("INBOX");
    expect(out).not.toContain("dead-letter");
  });

  it("pressing i opens the info screen with queue counts", async () => {
    const out = await mountAndType(db, ["i"]);
    expect(out).toContain("dead-letter");
    expect(out).toContain("firstpass daemon start");
    // the info surface is the most recent frame (stdout accumulates every frame,
    // so we compare where each surface last appears rather than mere presence)
    expect(out.lastIndexOf("dead-letter")).toBeGreaterThan(
      out.lastIndexOf("INBOX"),
    );
  });

  it("pressing i then escape returns to the inbox", async () => {
    const out = await mountAndType(db, ["i", "\x1b"]);
    // the inbox is rendered again after the info screen
    expect(out.lastIndexOf("INBOX")).toBeGreaterThan(
      out.lastIndexOf("dead-letter"),
    );
  });
});
