import { render, useApp, useInput, useWindowSize } from "ink";
import React from "react";

import {
  buildInitWizardModel,
  defaultInitSelections,
  nextInitStep,
  previousInitStep,
  validateInitSelections,
} from "./init-model.js";
import { InitWizardView } from "./init-view.js";

const { createElement: h, useState } = React;

function splitRepoInput(value) {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function selectedChoiceIndex(choices) {
  const index = choices.findIndex((choice) => choice.selected);
  return index === -1 ? 0 : index;
}

function applyChoice(state, choiceId) {
  if (state.currentStep === "agent") {
    if (choiceId === "auto" || choiceId === "custom") {
      return { ...state, agentMode: choiceId };
    }
    return { ...state, agentMode: "pinned", pinnedAgent: choiceId };
  }
  if (state.currentStep === "source") {
    if (state.sourceStage === "github") {
      return { ...state, githubScope: choiceId };
    }
    return { ...state, source: choiceId };
  }
  if (state.currentStep === "review") {
    if (choiceId === "service") {
      return { ...state, installService: true, startDaemon: true };
    }
    if (choiceId === "session") {
      return { ...state, installService: false, startDaemon: true };
    }
    return { ...state, installService: false, startDaemon: false };
  }
  return state;
}

function commitInputs(state) {
  if (state.source !== "github" || state.githubScope !== "explicit") {
    return state;
  }
  const repos = splitRepoInput(
    state.githubRepoInput || state.githubRepos.join(","),
  );
  return { ...state, githubRepos: repos, githubRepoInput: repos.join(", ") };
}

function printable(input) {
  return typeof input === "string" && input.length === 1 && input >= " ";
}

function appendActiveTextInput(state, input) {
  if (state.currentStep === "agent" && state.agentMode === "custom") {
    return {
      ...state,
      customAgent: state.customAgent + input,
      notice: "",
    };
  }
  if (
    state.currentStep === "source" &&
    state.sourceStage === "github" &&
    state.githubScope === "explicit"
  ) {
    return {
      ...state,
      githubRepoInput: state.githubRepoInput + input,
      notice: "",
    };
  }
  return null;
}

function InitWizardApp({ context, initialSelections, onSubmit, onCancel }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [state, setState] = useState(() =>
    defaultInitSelections(initialSelections ?? {}),
  );
  const model = buildInitWizardModel(state, context);

  function finishCancel() {
    onCancel();
    exit();
  }

  function finishSubmit(nextState) {
    const committed = commitInputs(nextState);
    const errors = validateInitSelections(committed);
    if (errors.length > 0) {
      setState({ ...committed, notice: errors[0] });
      return;
    }
    onSubmit(committed);
    exit();
  }

  useInput((input, key) => {
    if (printable(input)) {
      const next = appendActiveTextInput(state, input);
      if (next) {
        setState(next);
        return;
      }
    }
    if (input === "q") {
      finishCancel();
      return;
    }
    if (input === "b") {
      setState((current) => {
        if (
          current.currentStep === "source" &&
          current.sourceStage === "github"
        ) {
          return { ...current, sourceStage: "choose", notice: "" };
        }
        return {
          ...current,
          currentStep: previousInitStep(current.currentStep),
        };
      });
      return;
    }
    if (key.downArrow || input === "j" || key.upArrow || input === "k") {
      setState((current) => {
        const currentModel = buildInitWizardModel(current, context);
        const choices = currentModel.screen.choices;
        if (choices.length === 0) return current;
        const offset = key.upArrow || input === "k" ? -1 : 1;
        const nextIndex =
          (selectedChoiceIndex(choices) + offset + choices.length) %
          choices.length;
        return { ...applyChoice(current, choices[nextIndex].id), notice: "" };
      });
      return;
    }
    if (key.backspace || key.delete) {
      setState((current) => {
        if (current.currentStep === "agent" && current.agentMode === "custom") {
          return {
            ...current,
            customAgent: current.customAgent.slice(0, -1),
            notice: "",
          };
        }
        if (
          current.currentStep === "source" &&
          current.sourceStage === "github" &&
          current.githubScope === "explicit"
        ) {
          return {
            ...current,
            githubRepoInput: current.githubRepoInput.slice(0, -1),
            notice: "",
          };
        }
        return current;
      });
      return;
    }
    if (key.return) {
      const committed = commitInputs(state);
      if (committed.currentStep === "review") {
        finishSubmit(committed);
        return;
      }
      if (committed.currentStep === "source") {
        if (
          committed.sourceStage !== "github" &&
          committed.source === "github"
        ) {
          // Confirming GitHub opens its scope config rather than advancing.
          setState({ ...committed, sourceStage: "github", notice: "" });
          return;
        }
        if (committed.sourceStage === "github") {
          const errors = validateInitSelections(committed);
          if (errors.length > 0) {
            setState({ ...committed, notice: errors[0] });
            return;
          }
        }
      }
      setState({
        ...committed,
        currentStep: nextInitStep(committed.currentStep),
        notice: "",
      });
      return;
    }
  });

  return h(InitWizardView, {
    model,
    width: columns,
    height: Math.max(12, rows - 1),
  });
}

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export function startInitWizardTui(opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
  };
  const instance = render(
    h(InitWizardApp, {
      context: opts.context ?? {},
      initialSelections: opts.initialSelections,
      onSubmit: (value) => resolveResult(value),
      onCancel: () => resolveResult(null),
    }),
    { stdout, stdin, patchConsole: false },
  );
  void instance.waitUntilExit().then(
    () => resolveResult(null),
    () => resolveResult(null),
  );
  return { instance, restore, result };
}

export async function launchInitWizardTui(opts = {}) {
  const { instance, restore, result } = startInitWizardTui(opts);
  process.once("exit", restore);
  try {
    await instance.waitUntilExit();
    return await result;
  } finally {
    process.removeListener("exit", restore);
    restore();
  }
}
