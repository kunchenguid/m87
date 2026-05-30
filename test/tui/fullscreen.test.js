import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { startInteractiveTui } from "../../src/tui/app.js";

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";

// Minimal TTY doubles so Ink will mount and accept keypresses without a real
// terminal.
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

class FakeStdin extends EventEmitter {
  isTTY = true;
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
    return null;
  }
}

describe("tui/launchInteractiveTui fullscreen", () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m87-fs-"));
    db = createDatabase(join(dir, "t.sqlite"));
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("enters the alternate screen before painting and restores it on exit", async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const { instance, restore } = startInteractiveTui({
      db,
      agentTarget: "acp:claude",
      daemonPid: () => 1234,
      stdout: /** @type {any} */ (stdout),
      stdin: /** @type {any} */ (stdin),
    });
    // Let the component mount and render at least once, then tear down. We
    // assert on the FULL stream after teardown rather than mid-flight: Ink only
    // writes incremental frames in interactive mode - under CI (process.env.CI)
    // it batches and flushes the frame on unmount, so sampling before unmount
    // sees no content at all. Byte ordering proves the fix either way.
    await sleep(50);
    instance.unmount();
    await instance.waitUntilExit();
    restore();

    const enter = stdout.data.indexOf(ENTER_ALT);
    const content = stdout.data.indexOf("m87"); // the header brand
    const leave = stdout.data.indexOf(LEAVE_ALT);

    // The original bug switched buffers from a mounted effect, *after* the first
    // paint, so the frame went to the normal buffer and the alt screen stayed
    // blank. The fix enters the alt screen first, so ENTER_ALT precedes the
    // painted content, and the alt screen is left only after that content.
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(content).toBeGreaterThan(enter);
    expect(leave).toBeGreaterThan(content);
  });
});
