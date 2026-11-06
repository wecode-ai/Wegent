---
sidebar_position: 26
---

# Automation operation attribution verification

## User story and implementation boundary

As a project automation author, I want activity to show the triggering rule's name so that automated assignments and status changes do not look like my manual actions.

Cloud automation history snapshots `automation.rule_id`, `rule_name`, and `run_id`.
Assignment activity events retain the same source. Python event processing and Rust background dispatch write attribution; shared activity cards and history lists prefer the rule name.
Authorization users and permission checks remain unchanged. This does not change the permission model.
Renaming or deleting a rule does not rewrite history. Legacy records without attribution remain unchanged rather than guessing their source.

## E2E scenario

`frontend/e2e/tests/collaboration/automation-operation-attribution.spec.ts` runs in the existing Chromium CI project without a new CI job.

Prerequisites: isolated real Backend, MySQL, Redis and frontend services, a signed-in rule author, and another project member. The rule targets a human and needs no model service or model double.

1. Another member creates an Issue; the author configures a status-triggered rule.
2. Manually change the status and wait for the real automated assignment to persist.
3. Verify the rule ID, name and run ID; the authorizing user ID remains the rule author.
4. Open the Issue's “More properties” menu, expand assignment history, and verify that the operation displays the rule name.
5. Rename and disable the rule, manually reassign the Issue, and reload.
6. The historical automation keeps its original rule name. The new manual action shows its user's name without inherited automation attribution.

Cleanup reuses the project fixture's `finally` to archive the isolated project and workspace. Existing Playwright reports retain failure evidence; screenshots, logs and service launch scripts are not committed.

## Focused regressions

- Backend: automated creation, assignment and update; immutable rule-name snapshots; subsequent manual status updates.
- Rust: background source snapshots, isolation of older records, preserved authorizing users and assignment response serialization.
- Shared UI: automated/manual activity cards, assignment history and status history.
- Existing assignment/status permission regressions continue to verify that display attribution never replaces authorization identity.
