import { renderToString } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";

import { InitWizardView } from "../../src/setup/init-view.js";
import {
  buildInitWizardModel,
  defaultInitSelections,
} from "../../src/setup/init-model.js";

const h = React.createElement;

describe("setup/InitWizardView", () => {
  it("uses the existing terminal visual language without exposing test plugins", () => {
    const model = buildInitWizardModel(
      { ...defaultInitSelections(), currentStep: "agent" },
      {
        stateDir: "/tmp/firstpass-state",
        configExists: false,
        dbExists: false,
        detectedAgent: { spec: "acp:claude", id: "claude" },
        serviceManager: "launchd",
      },
    );

    const out = renderToString(
      h(InitWizardView, { model, width: 100, height: 30 }),
    );

    expect(out).toContain("firstpass");
    expect(out).toContain("setup wizard");
    expect(out).toContain("AI Agent");
    expect(out).toContain("Detect automatically");
    expect(out).toContain("GitHub");
    expect(out.toLowerCase()).not.toContain("mock");
  });

  it("marks the repository input with a cursor so it reads as editable", () => {
    const context = { stateDir: "/tmp/firstpass-state" };
    const repoInput = renderToString(
      h(InitWizardView, {
        model: buildInitWizardModel(
          {
            ...defaultInitSelections(),
            currentStep: "source",
            source: "github",
            sourceStage: "github",
            githubScope: "explicit",
          },
          context,
        ),
        width: 100,
        height: 30,
      }),
    );
    // The cursor block sits on the editable field, ahead of the placeholder.
    expect(repoInput).toContain("█");
    expect(repoInput).toContain("owner/repo");

    // Screens without a text field show no cursor.
    const noInput = renderToString(
      h(InitWizardView, {
        model: buildInitWizardModel(
          { ...defaultInitSelections(), currentStep: "agent" },
          context,
        ),
        width: 100,
        height: 30,
      }),
    );
    expect(noInput).not.toContain("█");
  });
});
