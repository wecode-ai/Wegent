---
sidebar_position: 35
---

# Versioned project collaboration strategy

The canonical pilot policy is [the Chinese strategy v2](../../../35-agentic-collaboration-strategy.md), covering W-0063 and decisions D029, D033, D036, D037 and D039–D047. Project maintainers publish readable strategy text with immutable revisions and a diff against the preceding revision. Users do not edit an execution graph.

## Inbox admission

New Issues remain in `inbox` without a six-stage label, stage task, assistant dispatch or stage timer. An authorized person admits an Issue only after its objective, scope, exclusions, acceptance criteria, dependencies, priority and proposed owner are complete and it has been selected for the current work period. An explicitly confirmed empty dependency list is valid. Missing requirements keep the Issue in the inbox with actionable feedback.

## Stages, reviewers and evidence

| Stage | Responsibility | Evidence required before advancing |
| --- | --- | --- |
| Proposal | Product | Objective, scope, exclusions and acceptance criteria |
| Joint review | Product, engineering, design and QA | At least one valid R&D, UI and QA `no_objection` for the current Issue and strategy versions, plus review conclusions, risks, schedule and owners |
| Preparation | Design, engineering, QA and product | Design, technical approach, test plan or cases and resolved open questions |
| Implementation | Engineering with clarification from other roles | A valid PR, testable build, self-test and integration results |
| Acceptance | QA, product, design and engineering | Test report, business and visual acceptance, closed defects or authorized risk acceptance |
| Release | A person authorized to release | All required PRs merged, release authorization, successful release version, production verification, rollback preparation and retrospective |

Joint-review decisions bind the stage, functional role, reviewer, conclusion, comment, evidence, Issue version, strategy version, time and idempotency key. A missing, objecting or conditional role keeps the Issue in joint review. Version-mismatched reviews are inactive. QA, product and UI hand off acceptance in that order; a finding keeps the acceptance stage active, marks it blocked and returns the owner to the appropriate fix owner.

Merge, release, high-risk actions, conflicting evidence and uncertain judgments require authorized human confirmation. Stage approval does not authorize an external Git merge or deployment.

## Status and stage consistency

Execution status and collaboration stage are independent and must remain in a valid combination. `inbox` permits only inbox; `pending` permits proposal, joint review and preparation; `in_progress` and `in_review` require at least implementation; `completed` requires release with a successful release record. Entering implementation changes the status to at least `in_progress` in the same transaction. Invalid combinations are rejected or repaired once with the old value, new value, actor, source and time recorded for PMO.

A valid PR URL in Issue content or activity establishes both the implementation-stage and `in_progress` lower bounds. The server applies both in one transaction and preserves them after badge removal. Indexing a PR does not admit the Issue directly to acceptance.

## PR quality and release gates

Acceptance entry requires every necessary PR to be non-draft, have all required checks successful for the current head, be `MERGEABLE`, and be explicitly scoped to the Issue with its head SHA and evidence. A failed, cancelled, timed-out or errored check blocks acceptance even when the PR is otherwise mergeable. Conflict or `DIRTY` also blocks acceptance. Before acceptance, either condition returns the Issue to implementation and the engineering owner; after acceptance, the stage remains active, is marked quality-blocked, and the owner returns to engineering. Repeated events do not repeat assignments or notifications.

Merging all required PRs completes engineering and QA, clears QA work and enters `in_review` plus release. Remaining product or visual acceptance is a pre-release check. An Issue becomes `completed` only after a successful release record contains every required merge commit and records the version or tag, URL, time, target environment, Issue mapping and verification result.

## Versions, roles and coordinator

Each running Issue stores a unique instance identity and an immutable strategy text, revision and role snapshot. Publishing affects future Issues. Upgrading a running Issue is explicit and records the actor, reason, old and new versions and migration impact without overwriting evidence or attempts.

Functional responsibilities never grant project permissions. Current membership, Issue visibility and action permissions remain authoritative. Proposal ownership belongs to product; changing it to another user, agent or collaboration group advances to joint review in the same transaction or is rejected.

The AI coordinator reads the Issue snapshot, authorized evidence, roles and events. Its recommendation references strategy and Issue versions, current stage, next owner and action, satisfied and missing conditions, evidence, clarification requests and an idempotency key. The server validates status, stage, review, PR, evidence, identity, permission, isolation and audit rules. Model text cannot grant authority.

Existing workflow definitions, instances, Deliveries and task outcomes store internal execution state. Internal graphs remain absent from product settings and the main Issue timeline.

## Tracking and dependencies

Inbox admission and every status or stage start, wait, block, completion, return or consistency repair produces a structured PMO mention and readable Issue summary. Recipients must currently be allowed to read the Issue. Failed delivery has an explicit diagnostic state; plain text mentions do not count. Idempotent retries do not duplicate decisions, review votes, assignments, notifications or releases.

W-0056 supplies the authorized assistant roster, dispatch and durable receipt contract through ProjectChatAgent and Issue assignments. W-0063 reuses it and does not create a second dispatcher. W-0070 separately owns concurrent requests, child conversations and Git worktree lifecycle; it does not block W-0063 acceptance.

Disabling `collab.agenticStrategy.v1` restores manual stages for new Issues while retaining published revisions, running snapshots, evidence and audit. Existing workflows can finish under their snapshots. Telemetry records gate violations, missing notification, invalid coordinator evidence, adoption latency, status-stage inconsistency and actual stage execution, wait and rework durations without inventing missing timing data.
