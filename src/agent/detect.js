import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

// Agent auto-detection. When `agent` is null in config we probe these provider
// CLIs (in order) on the probe path and resolve to the first present, mapping
// it to its acp: registry target.
const AUTODETECT_ORDER = [
  { id: "claude", binary: "claude" },
  { id: "codex", binary: "codex" },
  { id: "opencode", binary: "opencode" },
];

export function getAgentProbePath() {
  const override = process.env.FIRSTPASS_AGENT_PROBE_PATH;
  if (typeof override === "string") {
    return override;
  }
  return typeof process.env.PATH === "string" ? process.env.PATH : "";
}

function isExecutableFile(filePath) {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function binaryExistsOnPath(binary, probePath) {
  if (!probePath) {
    return false;
  }
  const candidates =
    process.platform === "win32"
      ? [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`]
      : [binary];
  for (const dir of probePath.split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of candidates) {
      if (isExecutableFile(join(dir, name))) {
        return true;
      }
    }
  }
  return false;
}

export function detectAgentSpec(probePath = getAgentProbePath()) {
  for (const entry of AUTODETECT_ORDER) {
    if (binaryExistsOnPath(entry.binary, probePath)) {
      return { spec: `acp:${entry.id}`, id: entry.id };
    }
  }
  return null;
}

/**
 * Resolve the effective agent for a config. An explicit acp: target wins; a
 * null agent triggers auto-detection. Returns { spec, source, detected }.
 */
export function resolveAgentDetection(config) {
  const agent = config && typeof config === "object" ? config.agent : null;
  if (typeof agent === "string") {
    return { spec: agent, source: "config", detected: null };
  }
  const detected = detectAgentSpec();
  if (detected) {
    return { spec: detected.spec, source: "auto", detected: detected.id };
  }
  return { spec: null, source: "none", detected: null };
}

export function resolveEffectiveAgentSpec(config) {
  return resolveAgentDetection(config).spec;
}
