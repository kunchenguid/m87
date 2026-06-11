import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/core/database.js";
import { localAutomationState } from "../../src/host/effects.js";

// Triage injects core-owned automation state so a re-triage fired by new
// source activity cannot recommend work an approved automation is already
// doing (the duplicated-fix incident).
describe("host/effects localAutomationState", () => {
  let dir;
  let db;
  const ITEM = "github:github:issue:o/r/69";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m87-autostate-"));
    db = createDatabase(join(dir, "t.sqlite"));
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for an item with no automation history", () => {
    expect(localAutomationState(db, ITEM)).toBeNull();
  });

  it("reports an open fix job with branch and prompt excerpt", () => {
    db.prepare(
      `insert into jobs (id,item_id,kind,status,phase,prompt,metadata_json,created_at,started_at,updated_at)
       values ('job-1', ?, 'fix','running','waiting_for_pr','', ?, 't','2026-06-11T15:49:09Z','t')`,
    ).run(
      ITEM,
      JSON.stringify({
        branch: "m87/fix-job-1",
        automation: { kind: "code fix", prompt: "update SKILL.md metadata" },
      }),
    );
    const state = localAutomationState(db, ITEM);
    expect(state.open_jobs).toHaveLength(1);
    expect(state.open_jobs[0]).toMatchObject({
      kind: "fix",
      status: "running",
      phase: "waiting_for_pr",
      branch: "m87/fix-job-1",
      prompt_excerpt: "update SKILL.md metadata",
    });
    expect(state.recent_jobs).toBeUndefined();
  });

  it("reports executed actions with their result url and the prior approval", () => {
    db.prepare(
      `insert into approvals (id,recommendation_id,option_id,item_id,decision,edited_actions_json,idempotency_key,created_at)
       values ('ap-1','rec-1','opt-1', ?, 'approved','[]','k','2026-06-11T15:49:09Z')`,
    ).run(ITEM);
    db.prepare(
      `insert into recommendation_options
         (id,recommendation_id,position,title,rationale,evidence_refs_json,confidence,waiting_on,actions_json,created_at)
       values ('opt-1','rec-1',0,'Implement the metadata fix','','[]','high','none','[]','t')`,
    ).run();
    db.prepare(
      `insert into action_results
         (id,approval_id,item_id,plugin_id,action_id,action_type,required,depends_on_json,safety,status,request_json,result_json,started_at,completed_at)
       values ('ap-1:a1','ap-1', ?, 'github','a1','comment',1,'[]','safe','succeeded','{}', ?, 't','2026-06-11T15:49:11Z')`,
    ).run(
      ITEM,
      JSON.stringify({ comment_url: "https://github.com/o/r/issues/69#c1" }),
    );
    const state = localAutomationState(db, ITEM);
    expect(state.recent_actions[0]).toMatchObject({
      action_type: "comment",
      status: "succeeded",
      url: "https://github.com/o/r/issues/69#c1",
    });
    expect(state.prior_approval).toEqual({
      option_title: "Implement the metadata fix",
      decided_at: "2026-06-11T15:49:09Z",
    });
  });

  it("separates open jobs from recently finished ones", () => {
    db.prepare(
      `insert into jobs (id,item_id,kind,status,phase,prompt,metadata_json,created_at,started_at,updated_at,completed_at)
       values ('job-done', ?, 'fix','succeeded','pr_opened','', ?, 't','t','t','2026-06-11T16:00:00Z')`,
    ).run(ITEM, JSON.stringify({ pr_url: "https://github.com/o/r/pull/80" }));
    const state = localAutomationState(db, ITEM);
    expect(state.open_jobs).toBeUndefined();
    expect(state.recent_jobs).toHaveLength(1);
    expect(state.recent_jobs[0]).toMatchObject({
      status: "succeeded",
      pr_url: "https://github.com/o/r/pull/80",
    });
  });

  it("ignores other items' automation", () => {
    db.prepare(
      `insert into jobs (id,item_id,kind,status,phase,prompt,metadata_json,created_at,updated_at)
       values ('job-x','other:item','fix','running','running_agent','','{}','t','t')`,
    ).run();
    expect(localAutomationState(db, ITEM)).toBeNull();
  });
});
