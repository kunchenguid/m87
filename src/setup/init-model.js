const STEP_ORDER = ["agent", "source", "review"];

const STEP_LABELS = {
  agent: "agent",
  source: "source",
  review: "review",
};

const GITHUB_SCOPE_LABELS = {
  explicit: "Specific repositories",
  owned: "Owned repositories",
  public_owned: "Public owned repositories",
  public_starred: "Public owned repositories you starred",
  authored_external: "Authored external work",
};

const VALID_SOURCES = new Set(["skip", "github"]);
const VALID_AGENT_MODES = new Set(["auto", "pinned", "custom"]);
const VALID_GITHUB_SCOPES = new Set(Object.keys(GITHUB_SCOPE_LABELS));

export function defaultInitSelections(overrides = {}) {
  return {
    currentStep: "agent",
    agentMode: "auto",
    pinnedAgent: "",
    customAgent: "",
    source: "skip",
    sourceStage: "choose",
    githubScope: "explicit",
    githubRepos: [],
    githubRepoInput: "",
    githubUsername: "",
    installService: true,
    startDaemon: true,
    stopDaemon: false,
    choiceIndex: 0,
    notice: "",
    ...overrides,
  };
}

function normalizeSelections(selections = {}) {
  const defaults = defaultInitSelections();
  const normalized = { ...defaults, ...selections };
  normalized.githubRepos = Array.isArray(normalized.githubRepos)
    ? normalized.githubRepos.filter((repo) => typeof repo === "string")
    : [];
  normalized.customAgent = String(normalized.customAgent ?? "").trim();
  normalized.pinnedAgent = String(normalized.pinnedAgent ?? "").trim();
  normalized.githubRepoInput = String(normalized.githubRepoInput ?? "").trim();
  normalized.githubUsername = String(normalized.githubUsername ?? "").trim();
  if (!STEP_ORDER.includes(normalized.currentStep)) {
    normalized.currentStep = defaults.currentStep;
  }
  if (!VALID_AGENT_MODES.has(normalized.agentMode)) {
    normalized.agentMode = defaults.agentMode;
  }
  if (!VALID_SOURCES.has(normalized.source)) {
    normalized.source = String(normalized.source ?? "");
  }
  if (normalized.sourceStage !== "github") {
    normalized.sourceStage = "choose";
  }
  if (!VALID_GITHUB_SCOPES.has(normalized.githubScope)) {
    normalized.githubScope = defaults.githubScope;
  }
  return normalized;
}

function isValidRepoName(repo) {
  return typeof repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(repo);
}

function githubConfig(selections) {
  if (selections.source !== "github") return {};
  const config = {};
  if (selections.githubUsername) {
    config.username = selections.githubUsername;
  }
  if (selections.githubScope === "explicit") {
    config.explicit_repos = selections.githubRepos;
  } else if (selections.githubScope === "owned") {
    config.owned_repos = true;
  } else if (selections.githubScope === "public_owned") {
    config.repo_conditions = ["all_public_owned"];
  } else if (selections.githubScope === "public_starred") {
    config.repo_conditions = ["all_public_owned_and_starred"];
  } else if (selections.githubScope === "authored_external") {
    config.authored_external = true;
  }
  return config;
}

export function validateInitSelections(input = {}) {
  const selections = normalizeSelections(input);
  const errors = [];

  if (!VALID_AGENT_MODES.has(selections.agentMode)) {
    errors.push("Agent mode must be auto or custom");
  }
  if (
    selections.agentMode === "custom" &&
    !selections.customAgent.startsWith("acp:")
  ) {
    errors.push("Custom agent targets must start with acp:");
  }
  if (
    selections.agentMode === "pinned" &&
    !selections.pinnedAgent.startsWith("acp:")
  ) {
    errors.push("Pinned agent targets must start with acp:");
  }
  if (!VALID_SOURCES.has(selections.source)) {
    errors.push("Setup supports GitHub or skipping source setup only");
  }
  if (
    selections.source === "github" &&
    !VALID_GITHUB_SCOPES.has(selections.githubScope)
  ) {
    errors.push("GitHub source scope is invalid");
  }
  if (selections.source === "github" && selections.githubScope === "explicit") {
    if (selections.githubRepos.length === 0) {
      errors.push("At least one GitHub repository is required");
    }
    for (const repo of selections.githubRepos) {
      if (!isValidRepoName(repo)) {
        errors.push(`Invalid GitHub repository: ${repo}`);
      }
    }
  }
  return errors;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

// Friendly display names for the AI agent CLIs we can talk to. The acp:
// target stays the source of truth; this is only what we show the user.
const AGENT_NAMES = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

function agentName(spec) {
  if (typeof spec !== "string" || spec.length === 0) {
    return "your AI agent";
  }
  const id = spec.startsWith("acp:") ? spec.slice(4) : spec;
  return AGENT_NAMES[id] ?? id;
}

export function buildInitApplyPlan(input = {}, context = {}) {
  const selections = normalizeSelections(input);
  const configValue =
    selections.agentMode === "custom"
      ? selections.customAgent
      : selections.agentMode === "pinned"
        ? selections.pinnedAgent
        : null;
  const agentLabel =
    selections.agentMode === "custom"
      ? agentName(selections.customAgent)
      : selections.agentMode === "pinned"
        ? agentName(selections.pinnedAgent)
        : context.detectedAgent?.spec
          ? `${agentName(context.detectedAgent.spec)} (auto-detected)`
          : "an auto-detected agent";
  const sourceConfig = githubConfig(selections);
  const commands = ["m87"];
  const sideEffects = [
    {
      id: "state",
      label: `Store your data in ${context.stateDir ?? "the M87 folder"}`,
    },
    { id: "database", label: "Set up your local inbox" },
    { id: "config", label: `Use ${agentLabel} for recommendations` },
  ];

  if (selections.source === "github") {
    sideEffects.push({
      id: "github",
      label: "Connect your GitHub repositories",
    });
    commands.unshift("m87 plugin add github");
    commands.unshift(
      [
        "m87 plugin configure github",
        ...Object.entries(sourceConfig).map(
          ([key, value]) =>
            `--config ${key}=${shellQuote(JSON.stringify(value))}`,
        ),
      ].join(" "),
    );
  }

  const daemonRunning = Boolean(context.daemonPid);
  const uninstallService =
    Boolean(context.serviceInstalled) && !selections.installService;
  if (selections.installService) {
    sideEffects.push({
      id: "service",
      label: daemonRunning
        ? "Keep M87 running and launch it automatically at startup"
        : "Start M87 now and launch it automatically at startup",
    });
    commands.unshift("m87 daemon install");
  } else if (selections.startDaemon) {
    if (uninstallService) {
      sideEffects.push({
        id: "service-uninstall",
        label: "Stop launching M87 automatically at startup",
      });
      commands.unshift("m87 daemon uninstall");
    }
    sideEffects.push({
      id: "daemon-start",
      label: daemonRunning
        ? "Keep M87 running for this session"
        : "Start M87 for this session",
    });
    if (!daemonRunning) commands.unshift("m87 daemon start");
  } else if (selections.stopDaemon && daemonRunning) {
    if (uninstallService) {
      sideEffects.push({
        id: "service-uninstall",
        label: "Stop launching M87 automatically at startup",
      });
      commands.unshift("m87 daemon uninstall");
    }
    sideEffects.push({
      id: "daemon-stop",
      label: "Stop M87 until you start it again",
    });
    commands.unshift("m87 daemon stop");
  }

  return {
    stateDir: context.stateDir ?? null,
    agent: {
      mode: selections.agentMode,
      label: agentLabel,
      configValue,
    },
    source:
      selections.source === "github"
        ? {
            type: "github",
            pluginId: "github",
            scope: selections.githubScope,
            scopeLabel: GITHUB_SCOPE_LABELS[selections.githubScope],
            config: sourceConfig,
          }
        : { type: "skip", pluginId: null, config: {} },
    daemon: {
      installService: Boolean(selections.installService),
      uninstallService,
      startDaemon: Boolean(selections.startDaemon),
      stopDaemon: Boolean(selections.stopDaemon) && daemonRunning,
    },
    sideEffects,
    commands: [...new Set(commands.reverse())],
    trustBoundaries: [
      "Source credentials stay with the local source plugin and provider CLI.",
      "ACP recommendations may send source-derived context to the configured agent target.",
      "The daemon runs as the sole background worker for sync, triage, and approved actions.",
      "Source-visible writes still require preview plus explicit approval.",
    ],
    errors: validateInitSelections(selections),
  };
}

function stepStatus(step, currentStep) {
  const current = STEP_ORDER.indexOf(currentStep);
  const index = STEP_ORDER.indexOf(step);
  if (index < current) return "done";
  if (index === current) return "current";
  return "todo";
}

function agentScreen(selections, context) {
  const detected = Array.isArray(context.detectedAgents)
    ? context.detectedAgents
    : [];
  const firstSpec = context.detectedAgent?.spec ?? detected[0]?.spec ?? null;
  const firstName = agentName(firstSpec);
  const otherNames = detected
    .map((agent) => agentName(agent.spec))
    .filter((name) => name !== firstName);
  let autoDetail;
  if (!firstSpec) {
    autoDetail = "We'll use Claude, Codex, or OpenCode if one is installed.";
  } else if (otherNames.length > 0) {
    autoDetail = `Will use ${firstName}. Also available: ${otherNames.join(", ")}.`;
  } else {
    autoDetail = `Will use ${firstName}.`;
  }
  const choices = [
    {
      id: "auto",
      label: "Detect automatically",
      detail: autoDetail,
      selected: selections.agentMode === "auto",
    },
  ];
  for (const agent of detected) {
    const name = agentName(agent.spec);
    choices.push({
      id: agent.spec,
      label: `Always use ${name}`,
      detail: `${name} is installed on your computer.`,
      selected:
        selections.agentMode === "pinned" &&
        selections.pinnedAgent === agent.spec,
    });
  }
  choices.push({
    id: "custom",
    label: "Enter a custom command",
    detail: selections.customAgent || "Advanced: provide an acp: target.",
    selected: selections.agentMode === "custom",
  });
  return {
    heading: "AI Agent",
    body: [
      "M87 uses an AI agent on your computer to draft recommendations.",
      "It may share details from your synced issues and pull requests with that agent.",
      "Next, connect GitHub or skip source setup for now.",
    ],
    choices,
  };
}

function sourceScreen(selections) {
  if (selections.sourceStage === "github") {
    return {
      heading: "Connect GitHub",
      body: [
        "Choose which repositories or activity M87 should sync.",
        "Make sure you're signed in to GitHub first (gh auth login).",
      ],
      choices: Object.entries(GITHUB_SCOPE_LABELS).map(([id, label]) => ({
        id,
        label,
        detail:
          id === "explicit"
            ? selections.githubRepos.length > 0
              ? selections.githubRepos.join(", ")
              : "Enter owner/repo below."
            : "M87 figures this out when it syncs.",
        selected: selections.githubScope === id,
      })),
      input:
        selections.githubScope === "explicit"
          ? {
              label: "Repository",
              value:
                selections.githubRepoInput || selections.githubRepos.join(", "),
              placeholder: "owner/repo",
            }
          : null,
    };
  }
  return {
    heading: "Connect a Source",
    body: [
      "Connect GitHub to sync your issues and pull requests, or skip for now.",
      "You can always add a source later.",
    ],
    choices: [
      {
        id: "github",
        label: "GitHub",
        detail: "Sync your issues and pull requests.",
        selected: selections.source === "github",
      },
      {
        id: "skip",
        label: "Skip for now",
        detail: "Set up M87 locally and add a source later.",
        selected: selections.source !== "github",
      },
    ],
  };
}

const DAEMON_EFFECT_IDS = new Set([
  "service",
  "service-uninstall",
  "daemon-start",
  "daemon-stop",
]);

function reviewChoices(selections, context) {
  if (context.daemonPid) {
    // M87 is already running: the choice is whether to keep it that way, not
    // whether to start it.
    return [
      {
        id: "service",
        label: "Keep running & launch at login",
        detail: context.serviceInstalled
          ? "Recommended. This is your current setup."
          : "Recommended. Keeps syncing in the background after every restart.",
        selected: selections.installService,
      },
      {
        id: "session",
        label: "Keep running (this session only)",
        detail: context.serviceInstalled
          ? "Keeps running now and stops launching automatically at startup."
          : "Keeps running until you restart your computer.",
        selected: !selections.installService && selections.startDaemon,
      },
      {
        id: "stop",
        label: "Stop running",
        detail: context.serviceInstalled
          ? "Stops background syncing and stops launching automatically at startup."
          : "Stops background syncing until you start M87 again.",
        selected: !selections.installService && !selections.startDaemon,
      },
    ];
  }
  return [
    {
      id: "service",
      label: "Start now & launch at login",
      detail:
        "Recommended. Syncs in the background now and after every restart.",
      selected: selections.installService,
    },
    {
      id: "session",
      label: "Start now (this session only)",
      detail: "Runs in the background until you restart your computer.",
      selected: !selections.installService && selections.startDaemon,
    },
    {
      id: "none",
      label: "Don't start it yet",
      detail: "You can start M87 yourself later.",
      selected: !selections.installService && !selections.startDaemon,
    },
  ];
}

function reviewScreen(selections, context, plan) {
  // Final step: review everything that will happen, and choose whether to run
  // M87 in the background. That choice (the radios below) drives the
  // service/session daemon, so its side effect is left out of the reviewed list
  // to avoid restating it.
  const body = plan.sideEffects
    .filter((effect) => !DAEMON_EFFECT_IDS.has(effect.id))
    .map((effect) => effect.label);
  if (context.daemonPid) {
    body.push("M87 is already running in the background.");
  }
  return {
    heading: "Review & Finish",
    body,
    choices: reviewChoices(selections, context),
  };
}

function screenFor(selections, context, plan) {
  if (selections.currentStep === "agent")
    return agentScreen(selections, context);
  if (selections.currentStep === "source") return sourceScreen(selections);
  return reviewScreen(selections, context, plan);
}

export function buildInitWizardModel(input = {}, context = {}) {
  const selections = normalizeSelections(input);
  const plan = buildInitApplyPlan(selections, context);
  return {
    title: "setup wizard",
    stateDir: context.stateDir ?? null,
    currentStep: selections.currentStep,
    steps: STEP_ORDER.map((id) => ({
      id,
      label: STEP_LABELS[id],
      status: stepStatus(id, selections.currentStep),
    })),
    screen: screenFor(selections, context, plan),
    plan,
    notice: selections.notice,
    errors: plan.errors,
  };
}

export function nextInitStep(currentStep) {
  const index = STEP_ORDER.indexOf(currentStep);
  return STEP_ORDER[Math.min(STEP_ORDER.length - 1, Math.max(0, index) + 1)];
}

export function previousInitStep(currentStep) {
  const index = STEP_ORDER.indexOf(currentStep);
  return STEP_ORDER[Math.max(0, index - 1)];
}

export function githubConfigFromSelections(selections = {}) {
  return githubConfig(normalizeSelections(selections));
}
