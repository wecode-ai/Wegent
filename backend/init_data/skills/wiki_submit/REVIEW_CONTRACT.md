# Code Wiki review contract

Read this file completely before opening, performing, or consuming a full-rebuild
review. It is the single source of truth for Writer/Reviewer handoffs.

## State machine

The Writer opens every attempt before delegating its Reviewer:

```text
not_started -> ready -> passed | changes_requested
```

`review-open` persists the handoff and returns `ready`. The Reviewer reads that exact
handoff with `review-status`, reviews it, and runs `review`. A verdict response uses
`state=passed` or `state=changes_requested`; `nextAction` is the Writer's required next
step. `attempt` is assigned by the server.

Writer command for every phase:

```bash
node wiki_submit.js review-open \
  --generation-id <id> \
  --phase <plan|qa|recheck> \
  --path <handoff-path> \
  --summary "<handoff conclusion>" \
  --handoff-file <contract-markdown>
```

Repeat `--path` for the complete phase scope. Then invoke the configured Reviewer with
the generation ID and phase. The Reviewer runs:

```bash
node wiki_submit.js review-status --generation-id <id> --phase <phase>
node wiki_submit.js review \
  --generation-id <id> \
  --phase <phase> \
  --review-status <passed|changes_requested> \
  --path <reviewed-path> \
  --summary "<evidence-based conclusion>"
```

For a passed Plan, repeat `--focus-path`. For `changes_requested`, add
`--findings-file <contract-markdown>`.

Every successful command returns one JSON object:

| Field | Meaning |
| --- | --- |
| `generationId` | Generation whose state was read or changed |
| `phase` | `plan`, `qa`, or `recheck` |
| `state` | `not_started`, `ready`, `passed`, or `changes_requested` |
| `attempt` | Server-assigned phase attempt, or null before opening |
| `nextAction` | The Writer's only valid next transition |
| `handoff` | Persisted Writer input when state is `ready` |
| `review` | Persisted Reviewer verdict after submission |

Run the Reviewer synchronously. After it returns, the Writer runs `review-status`
exactly once and follows `nextAction`. A remaining `ready` state means the Reviewer
returned without a verdict: fail the generation with that diagnostic. Do not sleep,
poll, or delegate a replacement Reviewer. Exit code 3 means the generation is terminal;
stop the current agent immediately.

Pages must remain unchanged between `review-open` and `review`. The backend rejects a
verdict if the candidate fingerprint changed during the review.

## Plan

The Writer finishes a concrete page plan, writes `/tmp/code-wiki-plan-handoff.md`, and
opens the review with every planned page as a repeated `--path`:

```markdown
# Plan handoff

- Commit: `<commit>`
- Repository scope: `<top-level components examined>`

## Pages

- `<path>` — `<reader purpose>`
  - Source evidence: `<files, symbols, or commands>`
  - Relationships: `<parents, children, and cross-links>`
  - Diagram: `<relationship or lifecycle to show, or none>`

## Cross-boundary coverage

- `<workflow or operational concern>` — `<pages that explain it>`

## Focus candidates

- `<path>` — `<why mechanism-level depth matters here>`
```

The Reviewer runs `review-status --phase plan`, reviews the persisted handoff, and
selects focus paths only when passing the plan. A passed Plan must submit every planned
path and at least one `--focus-path`. A changes verdict may omit focus paths but requires
`--findings-file`.

If attempt 1 requests changes, the Writer revises the complete plan and opens Plan
attempt 2 with a new handoff that includes a section mapping every prior finding to its
resolution. Attempt 2 `changes_requested` has `nextAction=fail_generation`.

## QA

After every planned page is submitted and Mermaid validation is current, the Writer
writes `/tmp/code-wiki-qa-handoff.md` and opens QA with every written page as `--path`:

```markdown
# QA handoff

- Commit: `<commit>`
- Candidate complete: yes
- Written paths: `<all paths, matching the command>`
- Validation performed: `<commands and results>`
- Known limitations: `<none, or explicit limitations>`
```

The Reviewer reads both `review-status --phase plan` and `review-status --phase qa`.
It inspects every Plan focus path, asks at least one falsifiable source-derived
mechanism question per focus page, and includes every focus path among its reviewed
`--path` values. `paths` means reviewed scope, not defective pages. Defective pages are
named in the findings file.

## Recheck

When QA requests changes, the Writer repairs only those findings, writes
`/tmp/code-wiki-recheck-handoff.md`, and opens Recheck with every repaired page as
`--path`:

```markdown
# Recheck handoff

## Repairs

### `<path>`

- QA finding: `<copy the finding>`
- Change made: `<specific repair>`
- Verification: `<source or command that now proves it>`
```

The Reviewer reads the QA and Recheck states, checks every listed repair against the
original finding, and does not broaden the scope. A Recheck verdict is final:
`passed` leads to completion and `changes_requested` leads to failure.

## Findings

Every `changes_requested` verdict supplies `--findings-file` using this format. One
section represents one actionable defect:

```markdown
# Findings

## `<page path>`

- Issue: `<what is missing or incorrect>`
- Evidence: `<source path, symbol, or reproducible check>`
- Required change: `<bounded acceptance criterion>`
```

A passed verdict has no findings file. Keep the short `--summary` as a conclusion;
put repair instructions in findings.
