import { childEvent, makeEvent } from "./event.js";
import { runChain } from "./handlers.js";
import {
  commit,
  dequeueDue,
  enqueue,
  nextAvailableAt,
  pendingCount,
  recordFailure,
} from "./queue.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const nowIso = () => new Date().toISOString();

/**
 * The single-threaded event loop (invariants I, III, VI, VII).
 *
 * One event is processed at a time. Processing is: run the handler chain inside
 * the commit-as-ack transaction (project + enqueue children + delete the queue
 * row, atomically), then launch any async effects AT THE EDGES (after commit).
 * Effects do the slow I/O (plugin/agent) off the loop and post RESULT EVENTS
 * back into the queue, closing the loop. A bounded pool gives backpressure.
 */
export function createLoop({
  db = undefined,
  effects = {},
  maxConcurrency = 4,
  onError = undefined,
} = {}) {
  const inFlight = new Set();
  const pendingEffects = []; // { spec, parent }
  // Set while runForever owns the loop; handed to effects so a daemon shutdown
  // can cancel slow I/O (e.g. an in-flight agent turn) at the edges.
  let loopSignal = undefined;

  function processOne(due) {
    let launched = [];
    try {
      commit(db, due.queueRow, (txdb) => {
        const result = runChain(txdb, due.event);
        launched = result.effects;
        return { children: result.children };
      });
    } catch (err) {
      // recordFailure runs in its own txn (the work txn already rolled back)
      const outcome = recordFailure(db, due.queueRow, err);
      onError?.(err, { event: due.event, outcome });
      return;
    }
    for (const spec of launched) {
      pendingEffects.push({ spec, parent: due.event });
    }
  }

  function makeApi(parent) {
    return {
      db,
      signal: loopSignal,
      // result events of a handler-triggered effect are children of the
      // triggering event => the causal chain (and depth budget) is preserved
      // across the async hop. Scheduler-launched effects (parent === null)
      // produce fresh ROOT facts (e.g. a sync discovering new source items).
      emit(input, opts = {}) {
        const event = parent
          ? childEvent(parent, input)
          : makeEvent({ actor: "core", ...input });
        enqueue(db, event, opts);
      },
      // enqueue an already-constructed event verbatim (e.g. plugin sync facts,
      // which are roots built by the host with their own actor + dedup_key).
      emitEvent(event, opts = {}) {
        enqueue(db, event, opts);
      },
    };
  }

  function pumpEffects() {
    while (inFlight.size < maxConcurrency && pendingEffects.length > 0) {
      const { spec, parent } = pendingEffects.shift();
      const runner = effects[spec.type];
      if (!runner) {
        onError?.(new Error(`no effect runner for '${spec.type}'`), { spec });
        continue;
      }
      const api = makeApi(parent);
      const promise = Promise.resolve()
        .then(() => runner(spec, api))
        .catch((err) => onError?.(err, { spec }))
        .finally(() => {
          inFlight.delete(promise);
          pumpEffects();
        });
      inFlight.add(promise);
    }
  }

  /** Process every currently-due event to quiescence. Returns count processed. */
  function processDueBatch() {
    let count = 0;
    let due;
    while ((due = dequeueDue(db, nowIso()))) {
      processOne(due);
      count += 1;
    }
    pumpEffects();
    return count;
  }

  /**
   * Drain the queue until quiescent: no due events, no in-flight effects, and no
   * future-scheduled events within `idleHorizonMs`. Used by one-shot runs/tests.
   */
  async function drain({ idleHorizonMs = 0 } = {}) {
    for (;;) {
      processDueBatch();
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
        continue;
      }
      const next = nextAvailableAt(db);
      if (!next) {
        return; // queue empty => fully quiescent
      }
      const waitMs = Date.parse(next) - Date.now();
      if (waitMs > idleHorizonMs) {
        return; // only future work remains beyond the horizon
      }
      await sleep(waitMs);
    }
  }

  /**
   * Daemon mode: block-when-idle. Processes due events, awaits in-flight
   * effects, otherwise sleeps until the next scheduled event (bounded by
   * tickMs so the scheduler can run). Stops when signal aborts.
   */
  async function runForever({
    signal = undefined,
    tickMs = 1000,
    onTick = undefined,
  } = {}) {
    loopSignal = signal;
    while (!signal?.aborted) {
      processDueBatch();
      if (onTick) {
        await onTick({ enqueue: (e, opts) => enqueue(db, e, opts) });
      }
      if (inFlight.size > 0) {
        await Promise.race([...inFlight, sleep(tickMs)]);
        continue;
      }
      const next = nextAvailableAt(db);
      const waitMs = next
        ? Math.min(tickMs, Date.parse(next) - Date.now())
        : tickMs;
      await sleep(waitMs);
    }
  }

  /** Launch an effect outside the handler path (e.g. the scheduler's sync). */
  function launchEffect(spec, parent = null) {
    pendingEffects.push({ spec, parent });
    pumpEffects();
  }

  /** Wait until all in-flight effects settle (so scheduled work completes). */
  async function settle() {
    while (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  return {
    drain,
    runForever,
    processDueBatch,
    launchEffect,
    settle,
    get inFlight() {
      return inFlight.size;
    },
    get pending() {
      return pendingCount(db);
    },
  };
}
