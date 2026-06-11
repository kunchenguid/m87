# Inbox Duplicate Recommendation And Selection Anchor Evidence

## Historical duplicate live recommendations

Seeded database state intentionally contains two live recommendations for one item:

[
{
"id": "rec-old",
"item_id": "mock:issue-69",
"summary": "Older recommendation",
"superseded_at": null
},
{
"id": "rec-new",
"item_id": "mock:issue-69",
"summary": "Newer duplicate recommendation",
"superseded_at": null
}
]

Actual end-user CLI command:

`M87_STATE_DIR=/Users/kunchen/.no-mistakes/worktrees/65a99c59c7f2/01KTT00V9YYSAB1MSNKS9WZ0N2/.no-mistakes/evidence/fix/inbox-duplicate-recs-and-ghost-highlight/tmp-cli-state node src/cli/index.js list`

CLI output shows one inbox row, selecting the newest live recommendation:

```yaml
inbox:
  - recommendation_id: rec-new
    summary: Newer duplicate recommendation
    item_id: mock:issue-69
    title: "Lavish AXI issue #69"
    url: mock://issue/69
    local_state: recommended
    attention_priority_hint: null
    options:
      - id: rec-new-opt-0
        position: 0
        title: Newer action
        confidence: high
```

## TUI selection anchor check

Scenario: the original recommendation is selected, a newer item arrives above it, then the user refreshes and presses `a` to approve.
The approval event still targets the original recommendation option, not the newer row.

Inbox order after newer arrival:

[
{
"recommendation_id": "rec-newer",
"title": "issue-2-newer-arrival",
"activity_at": "2024-01-03T00:00:00.000Z"
},
{
"recommendation_id": "rec-original",
"title": "issue-1-original-selection",
"activity_at": "2024-01-02T00:00:00.000Z"
}
]

Approval payload written by the interactive TUI:

{
"type": "approved",
"approval_id": "approval-rec-original",
"recommendation_id": "rec-original",
"option_id": "rec-original-opt-0",
"decision": "approved"
}

Captured TUI terminal output with ANSI stripped for review:

```text
nooze  r refresh  i info                    q quit │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│  m87   review queue                                              ● live   ◆ acp:claude   2 items │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────╮ ╭───────────────────────────────────────────────────────╮
│ INBOX                                  │ │ RECOMMENDATION                                        │
│ ● issue-2-newer-arrival                │ │ Handle issue-1-original-selection                     │
│   issue · 127w                         │ │                                                       │
│ ● issue-1-original-selection           │ │  1  medium  Approve                          1 action │
│   issue · 127w                         │ │                                                       │
│                                        │ │ ───────────────────────────────────────────────────── │
│                                        │ │ WILL DO · option 1                                    │
│                                        │ │  • comment                                            │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
│                                        │ │                                                       │
╰────────────────────────────────────────╯ ╰───────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ↑↓ move  1-9 select  a approve  d dismiss  s snooze  r refresh  i info                    q quit │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
 ▸ approve queued
```
