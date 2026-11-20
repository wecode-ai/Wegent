---
sidebar_position: 35
---

# Wework collaboration execution and authorization

Project Agent bindings, Agent resource owners, Issue assigners, and runner owners are distinct identities.
A project member can use an Agent authorized in its parent workspace without receiving permission to modify the source Team, Bot, or another user's model credentials.

```mermaid
flowchart LR
  Selection[Existing resource or new Agent] --> Binding[Project Agent binding]
  Binding --> Access[Personal sharing or active parent-workspace Team grant]
  Access --> Compile[Resolve Bot, Ghost and Shell in the Team owner's scope]
  Compile --> Queue[Durable execution queue]
  Queue --> Managed[Native managed jobs and authorization]
  Managed --> Task[Real Backend Task]
  Task --> Activity[Bind shared activity in the same transaction]
  Activity --> Status
  Queue --> Routing[Recheck environment grants, models and Issue runner affinity]
  Routing --> Wake[Notify the actual runner owner]
  Wake --> Pull[Runner claims work]
  Poll[Default 5-second polling] --> Pull
  Pull --> Accept[Runtime accepts the task]
  Accept --> Status[Execution status and result]
```

## Resources and editing

- Workspace Team access must match an active grant in the project's parent workspace. Removing that grant removes this authorization path.
- Resolve Team dependencies in the resource owner's scope. Continue validating execution models against the executing user's capabilities; sharing a Team does not expose another user's private model credentials.
- The server returns `can_edit`. Personal Teams require ownership; group Teams require Developer permission in their group. Project management permissions do not replace resource editing permissions.
- Local resources have no Team ID. The existing-Agent picker uses their supplied `project_binding_input` and preserves local execution configuration.
- The local resource catalog ensures the current-device Agent exists. Project configuration offers both existing-Agent selection and Agent creation.

## Delivery

Managed Wegent Issue execution uses the default-enabled native jobs `wegent.managed_issue.scan` and `wegent.managed_issue.execute`. The scan follows the queue polling interval and creates real Tasks under a separate distributed lock; execution and state projection retain current authorization checks. This flow is independent of optional Python job migration switches. An explicit `WEGENT_RS_JOB_ALLOWLIST` must include both jobs; existing scheduler and embedded-worker controls still apply.

Ordinary assignment requires no additional prompt: the managed Task uses the shared project, Issue, and execution reference, with optional instructions and continuation comments retained as supplementary text. A renewable execution lock protects each Task turn. If its process stops after committing `RUNNING`, durable redelivery can resume the same turn instead of skipping it solely because it is `RUNNING`. HTTP Executors reuse the automatic pipeline's turn idempotency key; Chat consumers clear old stream buffers before recovery and preserve terminal recovery. Terminal turns and mismatched identities are never dispatched again.

Video and research polling turns persist their handoff before external submission. A saved video job ID uses the existing video polling recovery. If a handoff is interrupted without a recoverable job ID, execution fails explicitly with unknown acceptance; providers without request deduplication are never automatically submitted again.

Server-managed Tasks use the `frontend` origin, matching their returned `/chat?taskId=...` entry and the default Task read API. The `project_automation` source and binding labels retain project provenance without placing these server conversations behind the desktop-origin filter.

The managed Task and its shared activity are bound in the same transaction. Ordinary assignments without a comment or automation activity create one node per execution; existing activities are reused. Terminal projection finds the node by its stable identity independently of the recent-message window, and replies continue the same Task through that node. Managed nodes never fabricate a device address.

The durable queue, atomic claim, and Runtime acceptance control task delivery. A wake notification only announces work; it carries no task and does not establish execution success.
Routed work notifies eligible devices using their owners' connection identities, after checking current grants, models, and Issue runner affinity.
`LOCAL_RUNTIME_WORK_POLL_INTERVAL` overrides the default five-second interval. Reconnection and availability notifications still initiate an immediate pull.

Running and terminal Runtime observations both lock and refresh their execution before writing back, preserving the execution-to-activity lock order. Acceptance acknowledgements or lease updates must not drop an already-received `response.created` because of a stale version. Device and owner matching, monotonic event sequences, and terminal-state protection remain unchanged.

## Stand-in assignment identities

For a direct human assignment, `human_task_binding.assignmentId` identifies the
Issue assignment event. In a collaboration round it identifies the manager's
member work; the additional `issueAssignmentId` identifies the current Issue
assignment event. Executor uses the latter for current-assignment validation and
reception receipts, persisting it as `issue_assignment_id` in task binding
metadata while retaining the member work ID for round coordination. Receipts
still require the current recipient, an owned device, and an owned task binding.

Manual delegation from a notification without an execution omits the stand-in
ID so Executor resolves an identity connected to the project, rather than
assuming `default`. Reassignment creates a new assignment event and an independent
stand-in task. The CI-covered `stand-in-assignment-notifications` suite verifies
notification dispatch, manual delegation, reassignment after completion, and
round reception receipts together.

## Manager status decisions

The server locks and refreshes the current execution record before applying a manager status decision. Issue status, execution completion and the manager comment commit in one transaction. If completion loses its version comparison, the server rolls back and returns `409`. Regressions cover stale-version refresh, conflict rollback and recovery with the same idempotency key.

## Verification cases

1. A project Maintainer can bind another member's workspace-authorized Agent while global configuration permissions remain unchanged.
2. Revoking the workspace Team grant blocks new bindings and execution across its child projects. Personal sharing does not bypass the workspace grant.
3. Shared runners receive notifications through their own identities, and revoked runner grants stop notifications.
4. A Bot routing-only update preserves its name and Shell and saves without uninitialized state.
5. Local projects can reuse the current-device Agent without creating a fictitious Team reference.

Focused unit and API tests cover these contracts. Desktop regression coverage extends the existing CI-covered `collaboration-local-agent-dispatch` scenario. Run local E2E and `ai:verify` only when explicitly requested.
