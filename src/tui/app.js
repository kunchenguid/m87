import { render, useApp, useInput, useWindowSize } from "ink";
import React from "react";

import { makeEvent } from "../core/event.js";
import { enqueue } from "../core/queue.js";
import { listInbox, logCursor } from "../core/views.js";
import { InboxView, InfoView } from "./components.js";
import { buildInboxModel, mainLayout, willDoWindow } from "./render.js";

const { createElement: h, useEffect, useRef, useState } = React;

// Interactive inbox. It TAILS the immutable log (polling a cheap cursor) and
// projects its own view - the UI is a read-side projection (no push). User
// keypresses ENQUEUE decision events for the daemon to process; the TUI never
// drives the loop itself (single consumer = the daemon). It can only act when a
// daemon is running.
function InboxApp({ db, agentTarget, daemonPid }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [selected, setSelected] = useState(0);
  // Which recommendation option is selected for the current item. 0 is the
  // agent's recommended option; number keys move it, `a` approves it. Reset to
  // the recommended option whenever the selected item changes.
  const [selectedOption, setSelectedOption] = useState(0);
  // How far the WILL DO detail is scrolled. j/k move it; reset whenever the item
  // or option changes (the detail content changes with them). maxScrollRef holds
  // the current scroll ceiling, recomputed each render from the live geometry.
  const [detailScroll, setDetailScroll] = useState(0);
  const maxScrollRef = useRef(0);
  const [cursor, setCursor] = useState(logCursor(db));
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("inbox");

  useEffect(() => {
    const timer = setInterval(() => {
      const next = logCursor(db);
      if (next !== cursor) {
        setCursor(next);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [cursor, db]);

  const inbox = listInbox(db);
  const current = inbox[Math.min(selected, Math.max(0, inbox.length - 1))];
  const currentRecommendationId = current?.recommendation_id ?? null;
  const previousRecommendationId = useRef(currentRecommendationId);
  const selectedOptionRecommendationId = useRef(currentRecommendationId);
  const effectiveSelectedOption =
    selectedOptionRecommendationId.current === currentRecommendationId
      ? selectedOption
      : 0;

  useEffect(() => {
    if (previousRecommendationId.current === currentRecommendationId) {
      return;
    }
    previousRecommendationId.current = currentRecommendationId;
    setSelectedOption(0);
    setDetailScroll(0);
  }, [currentRecommendationId]);

  // Enqueue a decision event for the daemon. Requires a live daemon; otherwise
  // the event would sit unprocessed, so we refuse and tell the user.
  function act(event, label) {
    if (!daemonPid()) {
      setNotice("daemon not running - start it with `m87 daemon start`");
      return;
    }
    enqueue(db, event, { lane: "interactive" });
    setNotice(`${label} queued`);
    setCursor(logCursor(db));
  }

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    // The info screen is a modal overlay: `i` toggles it, esc backs out, and
    // every other key is swallowed so inbox navigation/actions don't fire while
    // it's up.
    if (view === "info") {
      if (input === "i" || key.escape) {
        setView("inbox");
      }
      return;
    }
    if (input === "i") {
      setView("info");
      return;
    }
    // Arrows move between inbox items (and reset the option + detail scroll, since
    // the recommendation changes). j/k are reserved for scrolling the detail.
    if (key.downArrow) {
      setSelected((s) => Math.min(s + 1, inbox.length - 1));
      selectedOptionRecommendationId.current = null;
      setSelectedOption(0);
      setDetailScroll(0);
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(s - 1, 0));
      selectedOptionRecommendationId.current = null;
      setSelectedOption(0);
      setDetailScroll(0);
      return;
    }
    // j/k scroll the WILL DO detail so a long reply can be read in full before
    // approving. Clamped to the section's scroll ceiling (recomputed each render).
    if (input === "j") {
      setDetailScroll((s) => Math.min(s + 1, maxScrollRef.current));
      return;
    }
    if (input === "k") {
      setDetailScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (input === "r") {
      setCursor(logCursor(db));
      return;
    }
    if (!current) {
      return;
    }
    // Number keys SELECT an option (clamped to the live set); they never
    // approve. Approval stays a deliberate `a` so selecting can later expand an
    // option's detail before you commit.
    if (/^[1-9]$/.test(input)) {
      const count = db
        .prepare(
          "select count(*) c from recommendation_options where recommendation_id=?",
        )
        .get(current.recommendation_id).c;
      if (count > 0) {
        selectedOptionRecommendationId.current = currentRecommendationId;
        setSelectedOption(Math.min(Number(input) - 1, count - 1));
        setDetailScroll(0);
      }
      return;
    }
    if (input === "a" || input === "A") {
      const options = db
        .prepare(
          "select id from recommendation_options where recommendation_id=? order by position",
        )
        .all(current.recommendation_id);
      const option =
        options[Math.min(effectiveSelectedOption, options.length - 1)];
      if (option) {
        act(
          makeEvent({
            actor: "user",
            entity: "approval",
            lifecycle: "created",
            item_id: current.item_id,
            payload: {
              type: "approved",
              approval_id: `approval-${current.recommendation_id}`,
              recommendation_id: current.recommendation_id,
              option_id: option.id,
              decision: "approved",
            },
            dedup_key: `approval-${current.recommendation_id}`,
          }),
          "approve",
        );
      }
      return;
    }
    if (input === "d") {
      act(
        makeEvent({
          actor: "user",
          entity: "item",
          lifecycle: "updated",
          item_id: current.item_id,
          payload: { type: "dismissed", local_state: "dismissed" },
        }),
        "dismiss",
      );
      return;
    }
    if (input === "s") {
      const until = new Date(Date.now() + 86400000).toISOString();
      act(
        makeEvent({
          actor: "user",
          entity: "item",
          lifecycle: "updated",
          item_id: current.item_id,
          payload: {
            type: "snoozed",
            local_state: "snoozed",
            snoozed_until: until,
          },
        }),
        "snooze",
      );
    }
  });

  const model = buildInboxModel(db, {
    selectedIndex: selected,
    selectedOption: effectiveSelectedOption,
    detailScroll,
    agentTarget,
    daemonRunning: Boolean(daemonPid()),
    notice,
  });
  // Reserve the bottom row so the final line never scrolls the alt-screen.
  const height = Math.max(10, rows - 1);
  // Recompute how far the WILL DO detail can scroll, using the same geometry the
  // view draws with, so j/k clamp to exactly what's on screen.
  const selOpt =
    model.detail?.options.find((o) => o.selected) ?? model.detail?.options[0];
  if (model.detail && selOpt) {
    const { rightWidth, bodyHeight } = mainLayout(columns, height, notice);
    maxScrollRef.current = willDoWindow({
      detail: model.detail,
      opt: selOpt,
      paneWidth: rightWidth,
      paneHeight: bodyHeight,
      scroll: detailScroll,
    }).maxScroll;
  } else {
    maxScrollRef.current = 0;
  }
  const dims = { model, width: columns, height };
  return h(view === "info" ? InfoView : InboxView, dims);
}

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// Mount the TUI and return the Ink instance plus a one-shot `restore`. Split out
// from launchInteractiveTui so tests can assert the alt-screen handshake and
// unmount deterministically without simulating keypresses.
/**
 * @param {object} [opts]
 * @param {any} [opts.db]
 * @param {string} [opts.agentTarget]
 * @param {() => any} [opts.daemonPid]
 * @param {any} [opts.stdout]
 * @param {any} [opts.stdin]
 */
export function startInteractiveTui(opts = {}) {
  const { db, agentTarget, daemonPid } = opts;
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  // Switch to the alternate screen buffer BEFORE Ink's first paint so the frame
  // lands in the alt buffer. Doing this from a mounted effect runs *after* Ink
  // has already painted the normal buffer, which leaves the alt screen blank
  // until the next re-render - the empty-screen bug.
  stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
  };
  const instance = render(h(InboxApp, { db, agentTarget, daemonPid }), {
    stdout,
    stdin,
    // The TUI is a pure reader and never writes to console; leaving Ink's
    // console patch off keeps it from wrapping the global console.
    patchConsole: false,
  });
  return { instance, restore };
}

/** @param {Parameters<typeof startInteractiveTui>[0]} [opts] */
export function launchInteractiveTui(opts = {}) {
  const { instance, restore } = startInteractiveTui(opts);
  // If the process is torn down without unwinding the await (e.g. a signal),
  // still hand the terminal back instead of stranding the user in the alt
  // buffer with a hidden cursor.
  process.once("exit", restore);
  return instance.waitUntilExit().finally(() => {
    process.removeListener("exit", restore);
    restore();
  });
}
