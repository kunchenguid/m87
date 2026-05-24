import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Managed-service integration for `daemon install/uninstall`. Generates a
// launchd plist (macOS), systemd user unit (Linux), or schtasks cmd (Windows)
// that runs `firstpass daemon run` at login. FIRSTPASS_SERVICE_DRY_RUN skips the
// load/unload step (tests).

export function getServiceLabel(stateDir) {
  const hash = createHash("sha256")
    .update(typeof stateDir === "string" ? stateDir : "")
    .digest("hex")
    .slice(0, 10);
  return `com.firstpass.daemon.${hash}`;
}

export function isServiceDryRun() {
  const value = process.env.FIRSTPASS_SERVICE_DRY_RUN;
  return typeof value === "string" && value.length > 0 && value !== "0";
}

function renderLaunchdPlist(label, invocation, logPath) {
  const programArguments = [invocation.program, ...invocation.args]
    .map((value) => `    <string>${value}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>FIRSTPASS_DAEMON</key>",
    "    <string>1</string>",
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${logPath}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${logPath}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function renderSystemdUnit(invocation, logPath) {
  const execStart = [invocation.program, ...invocation.args]
    .map((value) => (/\s/.test(value) ? JSON.stringify(value) : value))
    .join(" ");
  return [
    "[Unit]",
    "Description=FirstPass local review daemon",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Environment=FIRSTPASS_DAEMON=1",
    "Restart=on-failure",
    "RestartSec=5",
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * @param {string} stateDir
 * @param {string} cliEntry absolute path to the firstpass CLI entry to invoke
 */
export function getServicePlan(stateDir, cliEntry) {
  const label = getServiceLabel(stateDir);
  const invocation = {
    program: process.execPath,
    args: [cliEntry, "daemon", "run"],
  };
  const logPath = join(stateDir, "daemon.log");
  const home = homedir();

  if (process.platform === "darwin") {
    const unitPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
    return {
      manager: "launchd",
      label,
      unitPath,
      content: renderLaunchdPlist(label, invocation, logPath),
      activate: { command: "launchctl", args: ["load", unitPath] },
      deactivate: { command: "launchctl", args: ["unload", unitPath] },
    };
  }
  if (process.platform === "linux") {
    const unitPath = join(
      home,
      ".config",
      "systemd",
      "user",
      `${label}.service`,
    );
    return {
      manager: "systemd",
      label,
      unitPath,
      content: renderSystemdUnit(invocation, logPath),
      activate: {
        command: "systemctl",
        args: ["--user", "enable", "--now", `${label}.service`],
      },
      deactivate: {
        command: "systemctl",
        args: ["--user", "disable", "--now", `${label}.service`],
      },
    };
  }
  if (process.platform === "win32") {
    const unitPath = join(stateDir, `${label}.cmd`);
    const invocationLine = [invocation.program, ...invocation.args]
      .map((value) => `"${value}"`)
      .join(" ");
    return {
      manager: "schtasks",
      label,
      unitPath,
      content: `@echo off\r\nset FIRSTPASS_DAEMON=1\r\n${invocationLine}\r\n`,
      activate: {
        command: "schtasks",
        args: [
          "/create",
          "/f",
          "/sc",
          "onlogon",
          "/tn",
          label,
          "/tr",
          unitPath,
        ],
      },
      deactivate: {
        command: "schtasks",
        args: ["/delete", "/f", "/tn", label],
      },
    };
  }
  return null;
}
