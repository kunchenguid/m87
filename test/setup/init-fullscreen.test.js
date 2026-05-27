import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { startInitWizardTui } from "../../src/setup/init-app.js";

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
  chunks = [];
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
    return this.chunks.shift() ?? null;
  }
  send(chunk) {
    this.chunks.push(chunk);
    this.emit("readable");
  }
}

function pressReturn(stdin) {
  stdin.send("\r");
}

describe("setup/init fullscreen wizard", () => {
  it("visits first-run choices after review before submitting", async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const { instance, restore, result } = startInitWizardTui({
      stdout: /** @type {any} */ (stdout),
      stdin: /** @type {any} */ (stdin),
      context: { stateDir: "/tmp/firstpass-state", serviceManager: "launchd" },
      initialSelections: {
        currentStep: "apply",
        installService: false,
        startDaemon: false,
      },
    });

    try {
      await sleep(50);
      pressReturn(stdin);

      const afterReview = await Promise.race([
        result.then(() => "resolved"),
        sleep(80).then(() => "pending"),
      ]);
      expect(afterReview).toBe("pending");

      pressReturn(stdin);
      const selections = await Promise.race([
        result,
        sleep(500).then(() => null),
      ]);
      expect(selections).not.toBeNull();
      expect(selections.currentStep).toBe("first-run");
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      restore();
    }
  });

  it("resolves as cancelled when the wizard exits without submitting", async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const { instance, restore, result } = startInitWizardTui({
      stdout: /** @type {any} */ (stdout),
      stdin: /** @type {any} */ (stdin),
      context: { stateDir: "/tmp/firstpass-state", serviceManager: "launchd" },
    });

    try {
      instance.unmount();
      await instance.waitUntilExit();

      const resolved = await Promise.race([
        result,
        sleep(200).then(() => "pending"),
      ]);
      expect(resolved).toBeNull();
    } finally {
      restore();
    }
  });
});
