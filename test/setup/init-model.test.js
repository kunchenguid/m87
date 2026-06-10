import { describe, expect, it } from "vitest";

import {
  buildInitApplyPlan,
  buildInitWizardModel,
  defaultInitSelections,
  validateInitSelections,
} from "../../src/setup/init-model.js";

const detectedAgents = [
  { spec: "acp:claude", id: "claude" },
  { spec: "acp:codex", id: "codex" },
];

const context = {
  stateDir: "/tmp/m87-state",
  configExists: false,
  dbExists: false,
  detectedAgent: detectedAgents[0],
  detectedAgents,
  serviceManager: "launchd",
};

const runningContext = { ...context, daemonPid: 4242, serviceInstalled: false };

describe("setup/init model", () => {
  it("opens on the agent step with no informational core step", () => {
    expect(defaultInitSelections().currentStep).toBe("agent");
    const model = buildInitWizardModel(defaultInitSelections(), context);
    expect(model.steps.map((step) => step.id)).not.toContain("core");
    expect(model.currentStep).toBe("agent");
    expect(model.screen.heading).toBe("AI Agent");
  });

  it("folds the background-daemon decision into the review step's choices", () => {
    const at = (selections) =>
      buildInitWizardModel(
        { ...defaultInitSelections(), currentStep: "review", ...selections },
        context,
      ).screen;

    // Three mutually exclusive ways to (not) run M87 in the background.
    const screen = at({ installService: true, startDaemon: true });
    expect(screen.choices.map((choice) => choice.id)).toEqual([
      "service",
      "session",
      "none",
    ]);
    expect(screen.choices.find((c) => c.id === "service").selected).toBe(true);

    expect(
      at({ installService: false, startDaemon: true }).choices.find(
        (c) => c.id === "session",
      ).selected,
    ).toBe(true);
    expect(
      at({ installService: false, startDaemon: false }).choices.find(
        (c) => c.id === "none",
      ).selected,
    ).toBe(true);
  });

  it("acknowledges an already-running M87 on the review step", () => {
    const model = buildInitWizardModel(
      { ...defaultInitSelections(), currentStep: "review" },
      runningContext,
    );
    // The status note replaces the misleading "Start now" framing.
    expect(model.screen.body.join("\n")).toContain("already running");
    expect(model.screen.choices.map((choice) => choice.id)).toEqual([
      "service",
      "session",
      "stop",
    ]);
    const [service, session, stop] = model.screen.choices;
    expect(service.label).toBe("Keep running & launch at login");
    expect(service.selected).toBe(true);
    expect(session.label).toBe("Keep running (this session only)");
    expect(stop.label).toBe("Stop running");
  });

  it("notes the current setup when the login service is already installed", () => {
    const model = buildInitWizardModel(
      { ...defaultInitSelections(), currentStep: "review" },
      { ...runningContext, serviceInstalled: true },
    );
    expect(model.screen.choices[0].detail).toContain("current setup");
    expect(model.screen.choices[1].detail).toContain(
      "stops launching automatically",
    );
    expect(model.screen.choices[2].detail).toContain(
      "stops launching automatically",
    );
  });

  it("plans keep-running instead of start when M87 is already running", () => {
    const service = buildInitApplyPlan(defaultInitSelections(), runningContext);
    expect(service.sideEffects.find((e) => e.id === "service").label).toContain(
      "Keep M87 running",
    );

    const session = buildInitApplyPlan(
      { ...defaultInitSelections(), installService: false },
      runningContext,
    );
    expect(
      session.sideEffects.find((e) => e.id === "daemon-start").label,
    ).toContain("Keep M87 running");
    // Starting again would be a no-op, so the plan does not pretend to do it.
    expect(session.commands).not.toContain("m87 daemon start");
    expect(session.sideEffects.map((e) => e.id)).not.toContain(
      "service-uninstall",
    );
  });

  it("plans startup removal when choosing session-only with startup enabled", () => {
    const plan = buildInitApplyPlan(
      { ...defaultInitSelections(), installService: false },
      { ...runningContext, serviceInstalled: true },
    );
    expect(plan.daemon.uninstallService).toBe(true);
    expect(plan.sideEffects.map((e) => e.id)).toContain("service-uninstall");
    expect(plan.commands).toEqual(
      expect.arrayContaining(["m87 daemon uninstall"]),
    );
    expect(plan.commands).not.toContain("m87 daemon start");
  });

  it("plans a stop when the user chooses to stop the running M87", () => {
    const selections = {
      ...defaultInitSelections(),
      installService: false,
      startDaemon: false,
      stopDaemon: true,
    };
    const plan = buildInitApplyPlan(selections, runningContext);
    expect(plan.daemon).toEqual({
      installService: false,
      uninstallService: false,
      startDaemon: false,
      stopDaemon: true,
    });
    expect(plan.sideEffects.map((e) => e.id)).toContain("daemon-stop");
    expect(plan.commands).toContain("m87 daemon stop");
  });

  it("plans startup removal before stop when startup is enabled", () => {
    const selections = {
      ...defaultInitSelections(),
      installService: false,
      startDaemon: false,
      stopDaemon: true,
    };
    const plan = buildInitApplyPlan(selections, {
      ...runningContext,
      serviceInstalled: true,
    });
    expect(plan.daemon.uninstallService).toBe(true);
    expect(plan.sideEffects.map((e) => e.id)).toContain("service-uninstall");
    expect(plan.commands.indexOf("m87 daemon uninstall")).toBeLessThan(
      plan.commands.indexOf("m87 daemon stop"),
    );
  });

  it("ignores a stale stop choice when nothing is running", () => {
    const selections = {
      ...defaultInitSelections(),
      installService: false,
      startDaemon: false,
      stopDaemon: true,
    };
    const plan = buildInitApplyPlan(selections, context);
    expect(plan.daemon.stopDaemon).toBe(false);
    expect(plan.sideEffects.map((e) => e.id)).not.toContain("daemon-stop");
  });

  it("keeps the review step free of daemon/launchd jargon", () => {
    const model = buildInitWizardModel(
      {
        ...defaultInitSelections(),
        currentStep: "review",
        installService: true,
        startDaemon: true,
      },
      context,
    );
    const reviewText = model.screen.body.join("\n").toLowerCase();
    expect(reviewText).not.toContain("daemon");
    expect(reviewText).not.toContain("launchd");
  });

  it("defaults to auto ACP, no source, and managed service setup", () => {
    const selections = defaultInitSelections();
    const plan = buildInitApplyPlan(selections, context);

    expect(plan.agent).toMatchObject({ mode: "auto", configValue: null });
    expect(plan.source).toMatchObject({ type: "skip", pluginId: null });
    expect(plan.daemon).toMatchObject({
      installService: true,
      startDaemon: true,
    });
    expect(plan.sideEffects.map((effect) => effect.id)).toEqual(
      expect.arrayContaining(["state", "database", "config", "service"]),
    );
    expect(plan.sideEffects.map((effect) => effect.id)).not.toContain("mock");
    expect(plan.trustBoundaries.join("\n")).toContain("ACP");
  });

  it("builds a GitHub explicit-repository plan without exposing test plugins", () => {
    const selections = {
      ...defaultInitSelections(),
      agentMode: "custom",
      customAgent: "acp:opencode",
      source: "github",
      githubScope: "explicit",
      githubRepos: ["kunchenguid/m87"],
      installService: false,
      startDaemon: false,
    };

    const plan = buildInitApplyPlan(selections, context);

    expect(plan.agent).toMatchObject({
      mode: "custom",
      configValue: "acp:opencode",
    });
    expect(plan.source).toMatchObject({
      type: "github",
      pluginId: "github",
      config: { explicit_repos: ["kunchenguid/m87"] },
    });
    expect(plan.commands).toContain("m87 plugin add github");
    expect(plan.commands.join("\n")).not.toContain("mock");
  });

  it("validates ACP targets and only allows GitHub or skip as setup sources", () => {
    expect(
      validateInitSelections({
        ...defaultInitSelections(),
        agentMode: "custom",
        customAgent: "opencode",
      }),
    ).toContain("Custom agent targets must start with acp:");

    expect(
      validateInitSelections({
        ...defaultInitSelections(),
        source: "mock",
      }),
    ).toContain("Setup supports GitHub or skipping source setup only");
  });

  it("renders the current wizard step from pure state", () => {
    const model = buildInitWizardModel(
      { ...defaultInitSelections(), currentStep: "agent" },
      context,
    );

    expect(model.title).toBe("setup wizard");
    expect(model.steps.map((step) => step.id)).toEqual([
      "agent",
      "source",
      "review",
    ]);
    expect(model.screen.heading).toBe("AI Agent");
    // Pin choice ids stay the acp: spec; only the visible labels are friendly.
    expect(model.screen.choices.map((choice) => choice.id)).toEqual([
      "auto",
      "acp:claude",
      "acp:codex",
      "custom",
    ]);
    const auto = model.screen.choices[0];
    expect(auto.selected).toBe(true);
    // The auto detail names the agent it will actually use (first found)
    // with friendly names, and calls out the others available to pin.
    expect(auto.detail).toContain("Will use Claude");
    expect(auto.detail).toContain("Codex");
    expect(auto.detail.indexOf("Claude")).toBeLessThan(
      auto.detail.indexOf("Codex"),
    );
    expect(auto.detail).not.toContain("acp:");
  });

  it("offers only auto and custom when no provider CLI is detected", () => {
    const model = buildInitWizardModel(
      { ...defaultInitSelections(), currentStep: "agent" },
      { ...context, detectedAgent: null, detectedAgents: [] },
    );
    expect(model.screen.choices.map((choice) => choice.id)).toEqual([
      "auto",
      "custom",
    ]);
  });

  it("pins a specific detected provider as an explicit acp target", () => {
    const selections = {
      ...defaultInitSelections(),
      currentStep: "agent",
      agentMode: "pinned",
      pinnedAgent: "acp:codex",
    };
    const model = buildInitWizardModel(selections, context);
    const codex = model.screen.choices.find(
      (choice) => choice.id === "acp:codex",
    );
    expect(codex.selected).toBe(true);
    expect(model.screen.choices[0].selected).toBe(false);

    const plan = buildInitApplyPlan(selections, context);
    expect(plan.agent).toMatchObject({
      mode: "pinned",
      configValue: "acp:codex",
    });
    expect(
      plan.sideEffects.find((effect) => effect.id === "config").label,
    ).toBe("Use Codex for recommendations");
    expect(validateInitSelections(selections)).toEqual([]);
  });

  it("combines the reviewed actions and the background-run choice on one screen", () => {
    const model = buildInitWizardModel(
      {
        ...defaultInitSelections(),
        currentStep: "review",
        installService: true,
      },
      context,
    );
    expect(model.screen.heading).toBe("Review & Finish");
    // The reviewed actions and the daemon decision live on one screen.
    expect(model.screen.body.length).toBeGreaterThan(0);
    // The daemon's own side effect drives the plan but is not restated in the
    // reviewed list, since the radios below already express that choice.
    expect(model.plan.sideEffects.map((effect) => effect.id)).toContain(
      "service",
    );
    const body = model.screen.body.join("\n").toLowerCase();
    expect(body).not.toContain("launch it automatically");
    expect(body).not.toContain("for this session");
  });

  it("shows the source radio (not GitHub config) until the GitHub stage is entered", () => {
    const radio = buildInitWizardModel(
      { ...defaultInitSelections(), currentStep: "source", source: "github" },
      context,
    );
    expect(radio.screen.heading).toBe("Connect a Source");
    expect(radio.screen.choices.map((choice) => choice.id)).toEqual([
      "github",
      "skip",
    ]);
    // Highlighting GitHub fills its radio but stays on the chooser screen.
    expect(
      radio.screen.choices.find((choice) => choice.id === "github").selected,
    ).toBe(true);

    const configuring = buildInitWizardModel(
      {
        ...defaultInitSelections(),
        currentStep: "source",
        source: "github",
        sourceStage: "github",
      },
      context,
    );
    expect(configuring.screen.heading).toBe("Connect GitHub");
    expect(configuring.screen.choices.map((choice) => choice.id)).toContain(
      "explicit",
    );
  });

  it("rejects a pinned agent that is not an acp target", () => {
    expect(
      validateInitSelections({
        ...defaultInitSelections(),
        agentMode: "pinned",
        pinnedAgent: "codex",
      }),
    ).toContain("Pinned agent targets must start with acp:");
  });

  it("keeps every wizard screen free of implementation jargon", () => {
    const base = {
      ...defaultInitSelections(),
      source: "github",
      installService: true,
      startDaemon: true,
      githubRepos: ["kunchenguid/m87"],
    };
    const screens = [
      { ...base, currentStep: "agent" },
      { ...base, currentStep: "source", sourceStage: "choose" },
      { ...base, currentStep: "source", sourceStage: "github" },
      { ...base, currentStep: "review" },
    ];
    // Terms a non-technical user should never have to see in the wizard.
    const jargon = [
      "daemon",
      "launchd",
      "systemd",
      "schtasks",
      "sqlite",
      "provider cli",
      "bundled",
      "login service",
      "registry",
    ];
    const contexts = [context, { ...runningContext, serviceInstalled: true }];
    for (const selections of screens) {
      for (const ctx of contexts) {
        const { screen, steps } = buildInitWizardModel(selections, ctx);
        const text = [
          ...steps.map((step) => step.label),
          screen.heading,
          ...screen.body,
          ...screen.choices.flatMap((choice) => [choice.label, choice.detail]),
          screen.input?.label,
          screen.input?.placeholder,
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        for (const term of jargon) {
          expect(
            text,
            `step ${selections.currentStep} leaks "${term}"`,
          ).not.toContain(term);
        }
      }
    }
  });
});
