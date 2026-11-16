# Code Wiki review contract

Read this file completely before opening, performing, or consuming a full-rebuild
review. It is the single source of truth for Writer/Reviewer handoffs.

## Review policy

Every review response includes the backend-persisted `reviewPolicy`:

- `plan_only` is the current default. Delegate the Reviewer for Plan, and only when a
  necessary omitted page is discovered, one bounded Plan amendment. After the effective
  Plan passes, write every planned page and call `complete`; never open QA or Recheck.
- `plan_and_qa` reserves the prior final-review workflow. Use its QA and Recheck
  sections only when the backend explicitly returns this policy.

Do not infer the policy from the team members or prompt wording. Follow the persisted
value and `nextAction`.

## State machine

The Writer opens every attempt before delegating its Reviewer:

```text
not_started -> ready -> passed | changes_requested
```

`review-open` persists the handoff and returns `ready`. The Reviewer reads that exact
handoff with `review-status`, reviews it, and runs `review`. A verdict response uses
`state=passed` or `state=changes_requested`; `nextAction` is the Writer's required next
step. `attempt` is assigned by the server.

`plan_amendment` is optional: before Plan passes its `not_started` action is
`complete_plan_review_first`; after Plan passes it is `continue_writing`. Open it only
through the bounded amendment procedure below, never merely because that phase exists.

Writer command for every phase:

```bash
node wiki_submit.js review-open \
  --generation-id <id> \
  --phase <plan|plan_amendment|qa|recheck> \
  --path <handoff-path> \
  --summary "<handoff conclusion>" \
  --handoff-file <contract-markdown> \
  [--writing-plan-file <plan-json>]
```

Repeat `--path` for the complete phase scope. Plan and Plan amendment require
`--writing-plan-file`; QA and Recheck reject it. Then invoke the configured Reviewer
with the generation ID and phase. The Reviewer runs:

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
| `phase` | `plan`, `plan_amendment`, `qa`, or `recheck` |
| `state` | `not_started`, `ready`, `passed`, or `changes_requested` |
| `attempt` | Server-assigned phase attempt, or null before opening |
| `reviewPolicy` | `plan_only` or the reserved `plan_and_qa` policy |
| `nextAction` | The Writer's only valid next transition |
| `handoff` | Persisted Writer input for the latest attempt, including after verdict |
| `review` | Persisted Reviewer verdict after submission |
| `effectivePlan` | Current approved paths, focus paths, and Writing Plan; use this for all writing after an amendment passes |
| `writing` | Effective planned, written, missing, and unexpected page paths after Plan passes |

Run the Reviewer synchronously. After it returns, the Writer runs `review-status`
exactly once and follows `nextAction`. A remaining `ready` state means the Reviewer
returned without a verdict: fail the generation with that diagnostic. Do not sleep,
poll, or delegate a replacement Reviewer. Exit code 3 means the generation is terminal;
stop the current agent immediately.

Pages must remain unchanged between `review-open` and `review`. The backend rejects a
verdict if the candidate fingerprint changed during the review.

## Plan

The Writer finishes a concrete page plan, writes `/tmp/code-wiki-plan-handoff.md` plus
`/tmp/code-wiki-writing-plan.json`, and opens the review with every planned page as a
repeated `--path`.

Use `coordinator` mode only for a compact repository whose substantive pages fit one
coherent writing context. Use `scoped` mode when independent runtime domains or
cross-system workflows need isolated research. Every planned path has exactly one
owner. Work Packages must be source- and concept-cohesive; do not create one Worker per
page by default.

```json
{
  "mode": "scoped",
  "language": "Chinese (Simplified)",
  "coordinator_paths": ["index", "quickstart", "architecture"],
  "work_packages": [
    {
      "id": "WP-01",
      "paths": ["architecture/runtime", "workflows/task-execution"]
    }
  ]
}
```

```markdown
# Plan handoff

- Commit: `<commit>`
- Output language: `<language matching the Writing Plan>`
- Repository scope: `<top-level components examined>`

## Pages

- `<path>` — `<reader purpose>`
  - Source evidence: `<files, symbols, or commands>`
  - Must explain:
    - `<M-01: source-derived mechanism, state, boundary, or failure question>`
  - Relationships: `<parents, children, and cross-links>`
  - Diagram: `<relationship or lifecycle to show, or none>`

## Cross-boundary coverage

- `<workflow or operational concern>` — `<pages that explain it>`

## Focus candidates

- `<path>` — `<why mechanism-level depth matters here>`

## Work Packages

### `<WP-01: cohesive scope>`

- Assigned pages: `<paths matching the JSON Writing Plan>`
- Shared source scope: `<entrypoints, state owners, integrations, and tests>`
- Cross-page contract: `<what belongs in each canonical page>`
- Out of scope: `<neighboring package or none>`
```

Pass the JSON file with `--writing-plan-file`. The backend rejects duplicate,
unassigned, or unknown page ownership. Scoped mode also requires an explicit output
language so a fresh Worker never depends on Coordinator conversation history. In
coordinator mode all paths are coordinator owned and `work_packages` is empty.

The Reviewer runs `review-status --phase plan`, reviews the persisted handoff and
structured Writing Plan, and selects focus paths only when passing the plan. Verify the
writing mode fits repository complexity, every important page has source-derived
`Must explain` coverage, and Work Packages are neither fragmented nor broad enough to
recreate one full-wiki context. A passed Plan must submit every planned path and at
least one `--focus-path`. A changes verdict may omit focus paths but requires
`--findings-file`.

If attempt 1 requests changes, the Writer revises the complete plan and opens Plan
attempt 2 with a new handoff that includes a section mapping every prior finding to its
resolution. Attempt 2 `changes_requested` has `nextAction=fail_generation`.

## Plan amendment

This is an escape hatch for a **necessary page omitted from a passed Plan**, not a
second planning loop. Only the Coordinator may open it, and only before QA starts.
Section Writers report a discovered omission to the Coordinator; they do not submit the
page or open this handoff themselves.

The amendment paths are the complete proposed effective set: retain every passed Plan
path and add at least one new path. Its Writing Plan also covers that complete set so
the Coordinator can assign the new page without relying on earlier conversation. The
backend rejects removed original paths, missing ownership, pages already written but no
longer declared, added pages written before the amendment, a second amendment round, and
an amendment after QA has started.

```bash
node wiki_submit.js review-open \
  --generation-id <id> \
  --phase plan_amendment \
  --path index \
  --path architecture \
  --path architecture/runtime \
  --summary "Add the runtime lifecycle page omitted from the passed Plan" \
  --handoff-file /tmp/code-wiki-plan-amendment.md \
  --writing-plan-file /tmp/code-wiki-amended-writing-plan.json
```

The handoff states the omitted page, source evidence, reader purpose, why existing pages
cannot absorb it, ownership, and the full final reading order. The Reviewer receives
only the generation ID and `plan_amendment`; it compares the persisted original Plan and
the precise addition. A passed amendment may add `--focus-path` for a new deep-dive page
but retains every original focus path. After it passes, read `effectivePlan` and
`writing` from `review-status`; they supersede the original Plan for all remaining
writing, final order, and publication checks.

One amendment gets the same bounded repair as Plan: its first `changes_requested`
returns `nextAction=revise_plan_amendment_then_open_plan_amendment`; a second one fails
the generation. A pending or rejected amendment blocks publication rather than silently
falling back to the smaller Plan.

## Writing and completion

After Plan passes, `review-status --phase plan` returns the original handoff, verdict,
and current `effectivePlan` plus `writing` progress. After a passed amendment, those
fields contain the amended ownership; use them rather than the original handoff. In
scoped mode, invoke the configured
Section Writer synchronously once per Work Package with only the generation ID and
package ID. It reads this state, writes only its assigned pages, and never opens or
submits a review. Use the returned `missingPaths` rather than subagent narration to
decide what remains. Coordinator-owned synthesis pages are written after their source
packages. In coordinator mode, do not delegate Section Writers.

Use `writing.missingPaths` and `writing.unexpectedPaths` to reconcile the durable page
set. Under `plan_only`, run applicable deterministic validation and call `complete`
only when no planned path is missing and no unexpected path remains. The publication
gate independently enforces the exact page set.

## Optional QA (`plan_and_qa` only)

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

The backend rejects QA until written paths exactly equal planned paths. The Reviewer
reads both `review-status --phase plan` and `review-status --phase qa`. It reads every
page and checks it against its purpose and `Must explain` contract. For every Plan focus
path it additionally asks at least one falsifiable source-derived mechanism question
and verifies the answer against source. The QA verdict must submit every candidate page
as `--path`; the backend rejects a partial reviewed scope. `paths` means reviewed
scope, not defective pages. Defective pages are named in the findings file.

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
