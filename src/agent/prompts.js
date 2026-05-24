import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Prompt assembly for the two agent-using jobs: triage (produce a
// recommendation) and fix (edit a workspace). Kept core-internal.

// User triage policy (FU-17): if ~/.firstpass/AGENTS.md exists its contents are
// appended to every triage prompt, so the operator can steer triage globally.
export function loadUserPolicy(stateDir) {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    return null;
  }
  const policyPath = join(stateDir, "AGENTS.md");
  if (!existsSync(policyPath)) {
    return null;
  }
  const contents = readFileSync(policyPath, "utf8").trim();
  return contents.length > 0 ? contents : null;
}

export function buildTriagePrompt(input) {
  return [
    "You are triaging a local-first FirstPass review item.",
    "Use the provided prompt context to produce a recommendation for what should happen next.",
    "Core policy: propose one to three grounded options, do not claim actions were taken, and respect that source-visible effects require explicit human approval.",
    "User policy, plugin source context, evidence, action catalog, and rerun instructions are provided in the Input object when available.",
    "Your final assistant message must be a single JSON object with this shape:",
    JSON.stringify(
      {
        recommendation: {
          summary: "string",
          evidence: [
            {
              id: "string",
              kind: "event | snippet | attachment | related_object | source_url | local_file",
              source_ref: "string",
              summary: "string",
              quote: "optional string",
              url: "optional string",
            },
          ],
          options: [
            {
              title: "string",
              rationale: "string",
              evidence_refs: ["evidence id"],
              confidence: "low | medium | high",
              waiting_on: "user | other | source | agent | none",
              actions: [
                {
                  id: "string",
                  action_type: "string",
                  params: {},
                  description: "string",
                  required: true,
                  depends_on: ["optional action id"],
                },
              ],
              automation: {
                kind: "optional string",
                prompt: "optional string",
              },
            },
          ],
        },
        usage: { tokens_in: "optional number", tokens_out: "optional number" },
      },
      null,
      2,
    ),
    "Return only JSON. Do not wrap it in Markdown fences. Do not include prose before or after the JSON.",
    "Input:",
    JSON.stringify(input, null, 2),
  ].join("\n\n");
}

export function buildFixPrompt(prompt, workspacePath) {
  return [
    "You are an FirstPass automation worker running a coding task.",
    `A working copy of the repository is checked out at: ${workspacePath}`,
    "Make the change described below directly in that working copy.",
    "Do not commit, push, or open a pull request yourself; FirstPass handles that after you finish.",
    "",
    "Task:",
    typeof prompt === "string" ? prompt : "",
  ].join("\n");
}
