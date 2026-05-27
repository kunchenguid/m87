import { randomUUID } from "node:crypto";

import { runAcpTurn } from "../agent/acp.js";
import {
  buildFixPrompt,
  buildTriagePrompt,
  loadUserPolicy,
} from "../agent/prompts.js";
import {
  detectPluginPr,
  pluginExecuteAction,
  pluginFetch,
  pluginSync,
  preparePluginWorkspace,
  pluginEventToCoreEvent,
  submitPluginWorkspace,
} from "./plugin.js";

// Concrete implementations of the loop's async effect kinds (plan §4 async
// jobs). Each runs the slow I/O (plugin subprocess / agent turn) OFF the loop
// and posts RESULT EVENTS back via api.emit / api.emitEvent. Whether a kind
// uses the agent is internal to the kind - the event vocabulary never says so.

const nowIso = () => new Date().toISOString();
const parseJson = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

function loadPlugin(db, pluginId) {
  return db.prepare("select * from plugins where id = ?").get(pluginId);
}

function loadItem(db, itemId) {
  return db.prepare("select * from items where id = ?").get(itemId);
}

/**
 * Build the four effect runners, closing over the daemon context.
 * @param {{ db, stateDir, config, agentSpec }} ctx
 */
export function createEffects(ctx) {
  const { db, stateDir, config = {}, agentSpec } = ctx;

  // sync: plugin diff -> root item events; persist the fingerprint baseline.
  async function sync(spec, api) {
    const plugin = loadPlugin(db, spec.plugin_id);
    if (!plugin) {
      throw new Error(`unknown plugin: ${spec.plugin_id}`);
    }
    const pconfig = parseJson(plugin.config_json, {});
    const fingerprints = parseJson(plugin.fingerprints_json, {});
    const res = await pluginSync(plugin.binary_path, {
      config: pconfig,
      fingerprints,
    });
    if (
      res.status === "rate_limited" ||
      res.status === "permission_denied" ||
      res.status === "error"
    ) {
      db.prepare(
        "update plugins set status=?, last_error=?, last_sync_at=? where id=?",
      ).run(res.status, res.warnings?.[0] ?? res.status, nowIso(), plugin.id);
      return;
    }
    for (const pe of res.events) {
      api.emitEvent(pluginEventToCoreEvent(plugin.id, pe), {
        lane: "background",
      });
    }
    db.prepare(
      "update plugins set fingerprints_json=?, status='active', last_error=null, last_sync_at=? where id=?",
    ).run(
      JSON.stringify(res.fingerprints ?? fingerprints),
      nowIso(),
      plugin.id,
    );
  }

  // triage: fetch context -> agent turn -> recommendation.created (child of the
  // item event). No-op when no agent is configured (mirrors prior behaviour).
  async function triage(spec, api) {
    if (!agentSpec) {
      return;
    }
    const item = loadItem(db, spec.item_id);
    if (!item || item.local_state !== "new") {
      return;
    }
    const plugin = loadPlugin(db, item.plugin_id);
    if (!plugin) {
      throw new Error(`unknown plugin for item ${spec.item_id}`);
    }
    const pconfig = parseJson(plugin.config_json, {});
    const context = await pluginFetch(plugin.binary_path, {
      config: pconfig,
      item_external_id: item.external_id,
    });
    const manifest = parseJson(plugin.manifest_json, {});
    const itemMetadata = parseJson(item.metadata_json, {});
    const role =
      typeof itemMetadata.role === "string" ? itemMetadata.role : null;
    // Contributor items (work you authored in repos you do not maintain) may
    // only use contributor-safe actions, so the agent never sees - and cannot
    // recommend - maintainer-only actions like merge/review/reopen (FU-2).
    const MAINTAINER_ONLY = new Set(["review", "merge", "reopen"]);
    const actionCatalog = (manifest.action_types ?? []).filter(
      (a) => role !== "contributor" || !MAINTAINER_ONLY.has(a?.type),
    );
    const userPolicy = loadUserPolicy(stateDir);
    const input = {
      item_id: item.id,
      plugin_source_context: {
        external_id: item.external_id,
        title: item.title,
        state: item.state,
        url: item.url,
        item_type: item.item_type,
        attention_reason: item.attention_reason,
        ...(role ? { role } : {}),
      },
      prompt_context: {
        human_context: context.human_context,
        agent_context: context.agent_context,
        evidence: context.evidence,
      },
      evidence_catalog: context.evidence,
      plugin_action_catalog: actionCatalog,
      ...(userPolicy ? { user_policy: userPolicy } : {}),
      ...(spec.rerun_instructions
        ? { rerun_instructions: spec.rerun_instructions }
        : {}),
    };
    const agentRunId = randomUUID();
    // Fresh session per run: a persistent per-item session can't be resumed by
    // the agent across separate CLI processes (e.g. sync then `rerun`).
    const sessionKey = `triage-${agentRunId}`;
    const startedAt = nowIso();
    db.prepare(
      `insert into agent_runs (id,item_id,recommendation_id,source_event_id,agent_spec,acp_target_redacted,acp_session_key,status,tokens_in,tokens_out,usage_estimated,started_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      agentRunId,
      item.id,
      null,
      null,
      agentSpec,
      agentSpec,
      sessionKey,
      "running",
      0,
      0,
      0,
      startedAt,
    );
    try {
      const { response, usage } = await runAcpTurn({
        agentSpec,
        config,
        stateDir,
        sessionKey,
        promptText: buildTriagePrompt(input),
        signal: api?.signal,
      });
      const rec = response?.recommendation;
      if (!rec || !Array.isArray(rec.options) || rec.options.length === 0) {
        throw new Error("agent returned no usable recommendation");
      }
      const recId = `rec-${agentRunId}`;
      db.prepare(
        "update agent_runs set recommendation_id=?, status='completed', tokens_in=?, tokens_out=?, completed_at=? where id=?",
      ).run(
        recId,
        usage?.tokens_in ?? 0,
        usage?.tokens_out ?? 0,
        nowIso(),
        agentRunId,
      );
      api.emit({
        entity: "recommendation",
        lifecycle: "created",
        // set item_id explicitly: triage can be launched standalone (rerun /
        // `triage`) with no parent event to inherit it from.
        item_id: item.id,
        payload: {
          type: "triage_result",
          recommendation_id: recId,
          agent_run_id: agentRunId,
          summary: rec.summary ?? "",
          evidence: rec.evidence ?? [],
          options: rec.options.map((o, i) => ({
            id: `${recId}-opt-${i}`,
            title: o.title ?? "",
            rationale: o.rationale ?? "",
            evidence_refs: o.evidence_refs ?? [],
            confidence: o.confidence ?? "medium",
            waiting_on: o.waiting_on ?? "none",
            actions: o.actions ?? [],
            automation: o.automation ?? null,
          })),
        },
      });
    } catch (err) {
      db.prepare(
        "update agent_runs set status='failed', error=?, completed_at=? where id=?",
      ).run(String(err?.message ?? err), nowIso(), agentRunId);
      throw err;
    }
  }

  // action: plugin execute-action -> action.closed.
  async function action(spec, api) {
    const item = loadItem(db, spec.item_id);
    const plugin = item ? loadPlugin(db, item.plugin_id) : null;
    if (!item || !plugin) {
      throw new Error(`action effect: missing item/plugin for ${spec.item_id}`);
    }
    const pconfig = parseJson(plugin.config_json, {});
    const itemRole = parseJson(item.metadata_json, {}).role;
    try {
      const result = await pluginExecuteAction(plugin.binary_path, {
        config: pconfig,
        item_external_id: item.external_id,
        action: spec.action,
        approval_id: spec.approval_id,
        idempotency_key: `${spec.approval_id}:${spec.action_id}`,
        ...(typeof itemRole === "string" ? { role: itemRole } : {}),
      });
      api.emit({
        entity: "action",
        lifecycle: "closed",
        payload: {
          type: "executed",
          action_id: spec.action_id,
          approval_id: spec.approval_id,
          status: result.status,
          result: result.external_result ?? null,
        },
      });
    } catch (err) {
      api.emit({
        entity: "action",
        lifecycle: "closed",
        payload: {
          type: "execute_failed",
          action_id: spec.action_id,
          approval_id: spec.approval_id,
          status: "failed",
          error: String(err?.message ?? err),
        },
      });
    }
  }

  // fix: prepare workspace -> fix agent turn -> submit -> job.updated/closed.
  async function fix(spec, api) {
    const job = db.prepare("select * from jobs where id = ?").get(spec.job_id);
    const item = job ? loadItem(db, job.item_id) : null;
    const plugin = item ? loadPlugin(db, item.plugin_id) : null;
    if (!job || !item || !plugin) {
      throw new Error(`fix effect: missing job/item/plugin for ${spec.job_id}`);
    }
    const pconfig = parseJson(plugin.config_json, {});
    const automation = parseJson(job.metadata_json, {}).automation ?? {};
    const itemRole = parseJson(item.metadata_json, {}).role;
    const jobRef = {
      id: job.id,
      kind: job.kind,
      item_external_id: item.external_id,
      ...(typeof itemRole === "string" ? { role: itemRole } : {}),
    };
    try {
      api.emit({
        entity: "job",
        lifecycle: "updated",
        payload: {
          type: "preparing",
          job_id: job.id,
          status: "running",
          phase: "preparing_workspace",
        },
      });
      const ws = await preparePluginWorkspace(plugin.binary_path, {
        config: pconfig,
        job: jobRef,
      });
      if (ws.status !== "prepared" || !ws.workspace_path) {
        throw new Error(ws.error ?? "workspace preparation failed");
      }
      api.emit({
        entity: "job",
        lifecycle: "updated",
        payload: {
          type: "running",
          job_id: job.id,
          status: "running",
          phase: "running_agent",
        },
      });
      if (agentSpec) {
        await runAcpTurn({
          agentSpec,
          config,
          stateDir,
          sessionKey: `fix-${job.id}`,
          promptText: buildFixPrompt(
            automation.prompt ?? job.prompt,
            ws.workspace_path,
          ),
          cwd: ws.workspace_path,
          parseJson: false,
          signal: api?.signal,
        });
      }
      api.emit({
        entity: "job",
        lifecycle: "updated",
        payload: {
          type: "submitting",
          job_id: job.id,
          status: "running",
          phase: "submitting",
        },
      });
      const submit = await submitPluginWorkspace(plugin.binary_path, {
        config: pconfig,
        job: jobRef,
        workspace_path: ws.workspace_path,
        approval_id: job.approval_id,
        idempotency_key: `fix:${job.id}`,
      });
      // The PR may not be detectable yet (e.g. the no-mistakes path opens it
      // asynchronously, or a contributor push awaits manual review). Keep the
      // job alive in waiting_for_pr so `job attach` can re-detect it (FU-15).
      if (submit.status === "waiting_for_pr") {
        api.emit({
          entity: "job",
          lifecycle: "updated",
          payload: {
            type: "waiting_for_pr",
            job_id: job.id,
            status: "running",
            phase: "waiting_for_pr",
            metadata: {
              branch: submit.branch,
              repository: submit.repository,
              commit: submit.commit,
            },
          },
        });
        return;
      }
      api.emit({
        entity: "job",
        lifecycle: "closed",
        payload: {
          type: submit.status === "no_changes" ? "no_changes" : "pr_opened",
          job_id: job.id,
          status: submit.status === "failed" ? "failed" : "succeeded",
          phase: submit.status === "failed" ? "failed" : "pr_opened",
          error: submit.error ?? null,
          metadata: { pr_url: submit.pr_url, commit: submit.commit },
        },
      });
    } catch (err) {
      api.emit({
        entity: "job",
        lifecycle: "closed",
        payload: {
          type: "failed",
          job_id: job.id,
          status: "failed",
          phase: "failed",
          error: String(err?.message ?? err),
        },
      });
    }
  }

  // fix_detect: re-check whether a waiting fix job's PR has appeared (FU-15).
  // Closes the job succeeded when found; otherwise leaves it waiting.
  async function fixDetect(spec, api) {
    const job = db.prepare("select * from jobs where id = ?").get(spec.job_id);
    const item = job ? loadItem(db, job.item_id) : null;
    const plugin = item ? loadPlugin(db, item.plugin_id) : null;
    if (!job || !item || !plugin) {
      throw new Error(`fix_detect effect: missing job/item/plugin`);
    }
    const pconfig = parseJson(plugin.config_json, {});
    const meta = parseJson(job.metadata_json, {});
    const repository =
      meta.repository ??
      item.external_id.split(":")[2]?.split("/").slice(0, 2).join("/");
    const branch = meta.branch;
    if (!branch || !repository) {
      throw new Error(
        `fix_detect effect: job ${job.id} has no branch/repository`,
      );
    }
    const result = await detectPluginPr(plugin.binary_path, {
      config: pconfig,
      repository,
      branch,
    });
    if (result.status === "submitted") {
      api.emit({
        entity: "job",
        lifecycle: "closed",
        payload: {
          type: "pr_opened",
          job_id: job.id,
          status: "succeeded",
          phase: "pr_opened",
          metadata: { pr_url: result.pr_url },
        },
      });
      return;
    }
    api.emit({
      entity: "job",
      lifecycle: "updated",
      payload: {
        type: "waiting_for_pr",
        job_id: job.id,
        status: "running",
        phase: "waiting_for_pr",
      },
    });
  }

  return { sync, triage, action, fix, fix_detect: fixDetect };
}
