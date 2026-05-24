import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";

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
    dir = mkdtempSync(join(tmpdir(), "firstpass-fs-"));
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
    // Let Ink flush its first paint into the (already-entered) alt buffer.
    await tick();

    const enter = stdout.data.indexOf(ENTER_ALT);
    const content = stdout.data.indexOf("firstpass"); // the header brand

    // The original bug switched buffers from a mounted effect, *after* the first
    // paint, so the frame went to the normal buffer and the alt screen stayed
    // blank. The fix enters the alt screen first, so ENTER_ALT precedes content.
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(content).toBeGreaterThan(enter);

    instance.unmount();
    await instance.waitUntilExit();
    restore();

    // On teardown the alt screen is left, after everything that was painted.
    const leave = stdout.data.indexOf(LEAVE_ALT);
    expect(leave).toBeGreaterThan(content);
  });
});
