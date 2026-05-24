# Fix-Job Execution Design

Status: draft for review.
Scope: turn firstpass's queued automation jobs into real coding-agent runs that produce a draft pull request, closing the biggest functional gap versus `ezoss`.
This document maps the work onto the existing jobs table, plugin protocol, and ACP runtime before any code is written.

## Goal And Non-Goals

| Goals                                                                                                    | Non-goals                                                     |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Execute an approved automation job: run a coding agent against a real checkout and open a draft PR.      | Auto-merging or any non-draft, non-reviewable write.          |
| Keep source specifics (clone, branch, commit, push, PR) in the plugin; keep agent orchestration in core. | Teaching the core about git or GitHub directly.               |
| Reuse the ACP runtime already used for triage.                                                           | A second agent integration path outside ACP.                  |
| Make the job state machine observable and recoverable.                                                   | Cross-device job state or hosted execution.                   |
| Respect the human-approval boundary the product is built on.                                             | Per-job autonomous policies before the audit trail is proven. |

## Current State (grounded)

Jobs are only ever queued, never run.

- The `jobs` table already exists with the right shape: `id, item_id, recommendation_id, option_id, kind, status, phase, prompt, metadata_json, error, created_at, started_at, updated_at, completed_at` (`src/database.js:176`).
- On approval, an option's `automation: { kind, prompt }` inserts one row with `status: "queued"`, `phase: "pending"`, `prompt`, `metadata_json: "{}"` (`src/cli.js:6249-6287`).
- `getAutomationJobStatus` / `listAutomationJobs` read jobs for `status` and the `firstpass job list` command (`src/cli.js:1979-2025`).
- There is no code that claims a queued job, runs anything, or transitions its phase. Grep for a runner finds none.
- The ACP runtime entrypoint `runAcpRuntimeTurn` runs a turn with `cwd: process.cwd()` (`src/cli.js:3726-3743`); it is not yet parameterized by a working directory.

So the data model and the queueing half exist; the execution half is missing entirely.

## Responsibility Split

The core already owns agent orchestration and the plugin owns source specifics.
Fix-job execution keeps that boundary.

| Step                                                      | Owner              | Why                                                      |
| --------------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| Decide a job is eligible and claim it                     | Core               | Core owns scheduling and job state.                      |
| Prepare a working copy (clone/worktree, branch, base ref) | Plugin             | Cloning and branch naming are source-specific.           |
| Run the coding agent in that working copy                 | Core (ACP runtime) | Agent orchestration is the core's single ACP boundary.   |
| Commit, push, open a draft PR                             | Plugin             | git write semantics and PR creation are source-specific. |
| Persist phase, result, audit                              | Core               | Core owns the durable record and audit trail.            |

This means two new plugin protocol commands and one new daemon stage.

## New Plugin Protocol Commands

Both follow the existing JSON-stdin/JSON-stdout convention and are declared in the manifest `capabilities` block so the core only offers fix jobs for plugins that support them.

### `prepare-automation-workspace`

Input: `{ account_id, job: { id, kind, item_external_id }, config }`.
Output: `{ status, workspace_path, base_ref, branch, cleanup_token, warnings }`.

The plugin clones or worktrees the repo into a path it controls (mirroring ezoss's persistent investigations checkout plus an ephemeral per-job worktree), creates the fix branch, and returns the absolute `workspace_path` for the core to run the agent in.
`status` is `prepared`, `unsupported`, or `failed`.

### `submit-automation-workspace`

Input: `{ account_id, job, workspace_path, approval_id, idempotency_key }`.
Output: `{ status, pr_url, commit, warnings, error }`.

The plugin stages and commits any agent changes, pushes the branch, and opens a draft PR, returning the PR URL.
It must be idempotent on `idempotency_key` (re-running a submit for the same job must not open a second PR) and must verify the branch actually has commits ahead of `base_ref` before pushing.
`status` is `submitted`, `no_changes`, or `failed`.

Both commands are `external_write`/`destructive`-class operations; the manifest declares that, and the UI treats them like any other source-visible write.

## Job State Machine

The job runs through explicit phases stored in `jobs.phase`, with `jobs.status` summarizing terminal state. This mirrors the item-state model already in the PRD.

| status      | phase                 | Meaning                                                      |
| ----------- | --------------------- | ------------------------------------------------------------ |
| `queued`    | `pending`             | Inserted at approval; not yet claimed.                       |
| `running`   | `preparing_workspace` | Daemon claimed it; plugin is cloning/worktreeing.            |
| `running`   | `running_agent`       | ACP coding agent is editing the workspace.                   |
| `running`   | `submitting`          | Plugin is committing/pushing/opening the PR.                 |
| `succeeded` | `pr_opened`           | Draft PR created; `metadata_json.pr_url` set.                |
| `succeeded` | `no_changes`          | Agent produced no diff; recorded, no PR.                     |
| `failed`    | `failed`              | Any step failed; `error` set, workspace left for inspection. |

Claiming is a guarded `update ... set status='running' where id=? and status='queued'` so two daemon cycles never run the same job (the same single-claim pattern the triage pass uses).
A stale-job sweep re-queues `running` jobs whose `updated_at` is older than a timeout (default 30m), matching ezoss's reclaim behavior.

## Daemon Job Stage

Add a Stage C to `runOneShotDaemonSync` after the triage pass (`src/cli.js:3286+`), gated like triage on a resolved agent (`resolveEffectiveAgentSpec`, already added in PR1).

Per cycle:

1. Reclaim stale `running` jobs back to `queued`.
2. Claim at most one `queued` job (bounded, to keep cycles short and writes deliberate).
3. `prepare-automation-workspace` via the item's plugin -> `preparing_workspace`.
4. Run the ACP coding agent in `workspace_path` with the job `prompt` (augmented: "the working copy is at X; make the change; do not open the PR yourself") -> `running_agent`.
5. `submit-automation-workspace` -> `submitting` -> `pr_opened` / `no_changes`.
6. Persist phase, `pr_url`, and the agent run record at each transition; emit IPC/daemon-event updates.

One job per cycle keeps remote writes paced and observable, and means the existing per-cycle daemon event can carry job progress without a new flooding concern (same lesson as PR2).

## ACP Runtime Changes

`runAcpRuntimeTurn` (`src/cli.js:3707`) and `createAcpRuntimeContext` (`src/cli.js:3515`) need a `cwd` parameter so a fix job runs the agent inside the prepared workspace instead of `process.cwd()`.
Triage keeps passing `process.cwd()`; the job stage passes `workspace_path`.
The agent for a fix job is the same resolved agent spec (auto-detected `acp:claude` etc.), and we reuse persistent sessions keyed by job id.
Usage and token accounting flow through the existing `agent_runs` plumbing, with a `recommendation_id` already on the job row.

## Approval And Safety Boundary

The human-approval boundary is satisfied at queue time: a job only exists because the user approved an option whose `automation` block created it (`src/cli.js:6249`).
The job's remote effect is constrained to a **draft** PR, which is reviewable and reversible, not a merge or a comment to another person.

Open decision: whether opening the draft PR needs a second explicit confirmation, or whether approval-at-queue-time plus draft-only is sufficient.
Recommendation for MVP: draft-only, audited, no second prompt, with a per-source config gate (`fixes.enabled`, `fixes.pr_create: draft | disabled`) mirroring ezoss, so a cautious user can run "prepare + agent, but commit only / no PR."

## Failure, Recovery, Idempotency

- A failed step sets `status: failed`, records `error`, and leaves the workspace on disk for inspection (ezoss does the same).
- `submit-automation-workspace` is idempotent on `idempotency_key` so a retried submit re-detects the existing PR instead of opening a duplicate.
- The stale-job reclaim handles a daemon crash mid-run.
- Workspaces are retained per the retention model; add a `workspace_ttl` so old checkouts are cleaned.

## Testing Strategy

Offline by default, mirroring the existing e2e style.

- Mock plugin gains `prepare-automation-workspace` / `submit-automation-workspace` returning a temp dir and a fake PR URL.
- e2e: approve an option with `automation`, run `daemon start --once`, assert the job transitions `queued -> pr_opened` and `metadata_json.pr_url` is set.
- e2e failure paths: prepare failure, agent no-op (`no_changes`), submit failure (`failed` + error), stale reclaim, idempotent re-submit.
- A GitHub-plugin contract test for the two new commands against recorded fixtures (no live network).
- ACP `cwd` is exercised by pointing the mock ACP target at the prepared workspace and asserting it ran there.

## Suggested Phasing

1. Core job runner + state machine + daemon Stage C, proven end-to-end with the **mock** plugin only (no GitHub yet). This is the bulk of the core work and is fully offline-testable.
2. ACP `cwd` parameterization.
3. GitHub plugin `prepare`/`submit` (worktree + `gh pr create --draft`), with recorded fixtures.
4. Config gates (`fixes.*`), workspace retention, and the second-approval decision.

Phase 1 alone makes "fix jobs actually run" true for the abstraction; phase 3 makes it true for GitHub.

## Open Questions

- Second approval before the draft PR, or draft-only + audit?
- Persistent per-repo checkout (ezoss-style investigations dir) versus a fresh clone per job - persistent is faster but adds state to manage.
- Should `submit` always open a PR, or support a "commit to a branch, no PR" mode for users who push through their own tooling (e.g. no-mistakes)?
