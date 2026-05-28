import { resolveEffectiveAgentSpec } from "../agent/detect.js";
import { createDatabase } from "../core/database.js";
import { noopLogger } from "../core/log.js";
import { createLoop } from "../core/loop.js";
import { createEffects } from "../host/effects.js";
import { getStatePaths, loadConfig } from "./state.js";

/**
 * Open the database and build a loop wired to the real effects (plugin + agent)
 * for the current config. Returns { db, loop, config, agentSpec, logger }.
 */
export function openRuntime({ onError = undefined, logger = noopLogger } = {}) {
  const { dbPath, stateDir } = getStatePaths();
  const config = loadConfig();
  const db = createDatabase(dbPath);
  const agentSpec = resolveEffectiveAgentSpec(config);
  const effects = createEffects({ db, stateDir, config, agentSpec, logger });
  const loop = createLoop({
    db,
    effects,
    onError: onError ?? (() => {}),
  });
  return { db, loop, config, agentSpec, stateDir, logger };
}

/**
 * Process the queue to quiescence with real effects (one-shot). Used by
 * mutating CLI commands when no daemon is running - the single-consumer
 * invariant holds because only one process drains at a time.
 */
export async function runOnce(runtime) {
  await runtime.loop.drain();
}

export { getStatePaths };
