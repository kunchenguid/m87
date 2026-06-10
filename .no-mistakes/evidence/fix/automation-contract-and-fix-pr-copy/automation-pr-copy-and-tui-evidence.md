# m87 Automation Contract and PR Copy Evidence

## GitHub draft PR created from an approved automation job

Plugin result: {"protocol_version":"m87.plugin.v2","status":"submitted","pr_url":"https://github.com/kunchenguid/m87/pull/99","commit":"5a6ebf330ca2defe76cdb4c065bea1d1336b9cce","branch":"m87/fix-job-1","repository":"kunchenguid/m87","warnings":[]}

Commit subject: Fix kunchenguid/m87#7: Crash on empty config

Draft PR title: Fix kunchenguid/m87#7: Crash on empty config

Draft PR body:

```markdown
Fixes kunchenguid/m87#7.

Approved option: Implement the fix: guard the empty config

Task:

Guard against an empty config object in loadConfig().

Prepared by m87 from an approved recommendation (job-1).
```

## no-mistakes gate path in auto mode

Plugin result: {"protocol_version":"m87.plugin.v2","status":"submitted","commit":"5a6dbd5f745df7e968caa7265d3f5dab4226d39d","branch":"m87/fix-job-1","repository":"kunchenguid/m87","pr_url":"https://github.com/kunchenguid/m87/pull/100","warnings":[]}

no-mistakes calls: [["--version"],["init"]]

Gate branch m87/fix-job-1 commit: 5a6dbd5f745df7e968caa7265d3f5dab4226d39d

Origin branch m87/fix-job-1 exists: false

## TUI automation label

The rendered inbox uses the agent-provided automation kind as the user-visible option tag:

```text
M87 Inbox  (1 item)
------------------------------------------------------------
> [0] mock:issue-1  Crash on empty config  issue · 0s  (recommended)
------------------------------------------------------------
Detail: Reply and fix
  (0) Reply  [medium]  1 action(s), code fix
  rec: rec-1
------------------------------------------------------------
Actions: ↑/↓ move · a approve · d dismiss · s snooze · r refresh · q quit
------------------------------------------------------------
Status: agent=none  events=0  pending=0  dead_letter=0
```
