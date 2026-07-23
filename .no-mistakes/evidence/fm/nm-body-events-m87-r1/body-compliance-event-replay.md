# PR body compliance event replay

The committed m87 workflow was parsed and its real signature-check shell step was executed for three PR-body events at the same fixed head, `0cb55b10b17d299c056a1e8ba063f8327513b5f7`.

|   Run ID | Run number | Action | Head SHA                                   | Concurrency group                | Terminal conclusion |
| -------: | ---------: | ------ | ------------------------------------------ | -------------------------------- | ------------------- |
| `401001` |        101 | opened | `0cb55b10b17d299c056a1e8ba063f8327513b5f7` | `no-mistakes-required-30-401001` | **success**         |
| `401002` |        102 | edited | `0cb55b10b17d299c056a1e8ba063f8327513b5f7` | `no-mistakes-required-30-401002` | **failure**         |
| `401003` |        103 | edited | `0cb55b10b17d299c056a1e8ba063f8327513b5f7` | `no-mistakes-required-30-401003` | **success**         |

## Reviewer-visible run titles

```text
PR #30 body compliance - opened - event 101 (run 401001)
PR #30 body compliance - edited - event 102 (run 401002)
PR #30 body compliance - edited - event 103 (run 401003)
```

## Actual compliance-step output

### opened run 401001 - success

```text
Found no-mistakes signature in PR #30 body.
```

Exit status: `0`

### edited run 401002 - failure

```text
::error::This PR was not raised through no-mistakes.

Contributions to this repository must be submitted via 'git push no-mistakes'.
That pipeline runs the required review/test/lint/CI steps and writes a
deterministic '## Pipeline' section into the PR body containing:

    Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)

See CONTRIBUTING.md for setup and the full workflow.

PR author: first-time-fork-contributor
```

Exit status: `1`

### edited run 401003 - success

```text
Found no-mistakes signature in PR #30 body.
```

Exit status: `0`

## Preserved contract checks

- Local workflow delta exactly equals the canonical two-hunk workflow patch from merged `kunchenguid/no-mistakes#558`.
- `synchronize` and `reopened` both render `no-mistakes-required-30-head-change`.
- Trigger remains `pull_request` for `opened`, `edited`, `synchronize`, and `reopened` against `main`.
- Permissions remain exactly `contents: read`; no secrets or checkout of fork code are present.
- `cancel-in-progress: true`, stable check name, signature marker, and all three bot exemptions remain intact.
