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

function pressDown(stdin) {
  stdin.send("\x1b[B");
}

async function typeText(stdin, value) {
  for (const char of value) {
    stdin.send(char);
    await sleep(1);
  }
}

async function submitStep(stdin) {
  pressReturn(stdin);
  await sleep(30);
}

describe("setup/init fullscreen wizard", () => {
  it("submits from the combined review step, carrying the background-run choice", async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const { instance, restore, result } = startInitWizardTui({
      stdout: /** @type {any} */ (stdout),
      stdin: /** @type {any} */ (stdin),
      context: { stateDir: "/tmp/firstpass-state", serviceManager: "launchd" },
      initialSelections: { currentStep: "review" },
    });

    try {
      await sleep(50);
      // Default is "Start now & launch at login"; move down to the session-only
      // option on the same screen.
      pressDown(stdin);
      await sleep(20);
      // A single confirm submits straight from review - there is no separate
      // step to click through anymore.
      pressReturn(stdin);
      const selections = await Promise.race([
        result,
        sleep(500).then(() => null),
      ]);
      expect(selections).not.toBeNull();
      expect(selections.currentStep).toBe("review");
      expect(selections.installService).toBe(false);
      expect(selections.startDaemon).toBe(true);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      restore();
    }
  });

  it("highlights GitHub without entering its config; selecting skip advances past source", async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const { instance, restore, result } = startInitWizardTui({
      stdout: /** @type {any} */ (stdout),
      stdin: /** @type {any} */ (stdin),
      context: { stateDir: "/tmp/firstpass-state", serviceManager: "launchd" },
      initialSelections: { currentStep: "source", source: "github" },
    });

    try {
      await sleep(50);
      // Moving the highlight to skip must not jump into GitHub config.
      pressDown(stdin);
      await sleep(20);
      await submitStep(stdin); // source (skip) -> review
      await submitStep(stdin); // review -> submit

      const selections = await Promise.race([
        result,
        sleep(500).then(() => null),
      ]);
      expect(selections).not.toBeNull();
      expect(selections.source).toBe("skip");
      expect(selections.currentStep).toBe("review");
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      restore();
    }
  });

  it("opens GitHub scope config on confirm before advancing", async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const { instance, restore, result } = startInitWizardTui({
      stdout: /** @type {any} */ (stdout),
      stdin: /** @type {any} */ (stdin),
      context: { stateDir: "/tmp/firstpass-state", serviceManager: "launchd" },
      initialSelections: {
        currentStep: "source",
        source: "github",
        githubScope: "explicit",
      },
    });

    try {
      await sleep(50);
      await submitStep(stdin); // confirm GitHub -> enter scope config (no advance)
      await typeText(stdin, "kunchenguid/firstpass");
      await submitStep(stdin); // scope config -> review
      await submitStep(stdin); // review -> submit

      const selections = await Promise.race([
        result,
        sleep(500).then(() => null),
      ]);
      expect(selections).not.toBeNull();
      expect(selections.source).toBe("github");
      expect(selections.githubRepos).toEqual(["kunchenguid/firstpass"]);
      expect(selections.currentStep).toBe("review");
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

  it("routes printable shortcut keys to active text fields", async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const { instance, restore, result } = startInitWizardTui({
      stdout: /** @type {any} */ (stdout),
      stdin: /** @type {any} */ (stdin),
      context: { stateDir: "/tmp/firstpass-state", serviceManager: "launchd" },
      initialSelections: {
        currentStep: "source",
        source: "github",
        sourceStage: "github",
        githubScope: "explicit",
        githubRepoInput: "",
      },
    });

    try {
      await sleep(50);
      await typeText(stdin, "kunchenguid/firstpass");
      await submitStep(stdin);
      await submitStep(stdin);
      await submitStep(stdin);
      await submitStep(stdin);

      const selections = await Promise.race([
        result,
        sleep(500).then(() => null),
      ]);
      expect(selections).not.toBeNull();
      expect(selections.githubScope).toBe("explicit");
      expect(selections.githubRepos).toEqual(["kunchenguid/firstpass"]);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      restore();
    }
  });
});
