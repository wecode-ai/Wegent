---
sidebar_position: 34
---

# Collaboration Workspace Storage Model

This document defines how collaboration workspaces are persisted without
introducing a second resource system. The implementation reuses the existing
`kinds`, `resource_members`, `loop_items`, `project_chat_messages`, and
`loop_item_executions` tables.

## Principles

1. Independently defined, reusable, and authorizable capabilities belong in
   `kinds`.
2. Access granted to a user or collaboration workspace belongs in
   `resource_members`.
3. Projects, Issues, comments, and deliverables remain in `loop_items`.
4. An Assignment is an Issue activity, not a separate source-of-truth table.
5. Runs remain in `loop_item_executions`.
6. Relationships do not use database foreign keys. Services validate resource
   type, status, and access.
7. Do not add dedicated reverse lookup tables or indexes before an actual
   access pattern requires them.

## Entity storage

| Product concept              | Storage                | Representation                                |
| ---------------------------- | ---------------------- | --------------------------------------------- |
| Collaboration Workspace      | `kinds`                | `kind = CollaborationWorkspace`               |
| Human member                 | `resource_members`     | User access to CollaborationWorkspace         |
| Agent                        | `kinds`                | Existing `kind = Team`                        |
| Execution environment        | `kinds`                | Existing `kind = Device`                      |
| Workspace Agent access       | `resource_members`     | CollaborationWorkspace access to Team         |
| Workspace environment access | `resource_members`     | CollaborationWorkspace access to Device       |
| Project                      | `loop_items`           | Existing `resource_type = project`            |
| Project in Workspace         | `resource_members`     | CollaborationWorkspace access to CloudProject |
| Issue                        | `loop_items`           | Existing Issue node                           |
| Issue activity               | `loop_items`           | `resource_type = comment`                     |
| Run                          | `loop_item_executions` | Existing execution record                     |

The code-level kind is named `CollaborationWorkspace` to avoid a collision with
the existing `Workspace` CRD in the `tasks` table, which represents a code
directory used by a Task. The product UI may continue to display “Workspace”.

## Collaboration Workspace Kind

A collaboration workspace uses the standard Kind identity:

```text
user_id + kind + namespace + name
```

Example:

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "CollaborationWorkspace",
  "metadata": {
    "name": "Engineering Workspace",
    "namespace": "default"
  },
  "spec": {
    "description": "Product and engineering collaboration",
    "isDefault": true
  },
  "status": {
    "state": "active",
    "version": 1
  }
}
```

`kinds.user_id` remains the creator identity. Membership and authorization must
also be recorded in `resource_members`.

## Generic authorization edges

`resource_members` expresses that a principal may use a resource. There are no
database foreign keys; services maintain logical integrity.

Human membership:

```text
resource_type = Workspace
resource_id   = collaboration_workspace_kind_id
entity_type   = user
entity_id     = user_id
role          = Owner | Maintainer | Developer | Reporter
status        = approved
```

Workspace access to an Agent:

```text
resource_type = Team
resource_id   = team_kind_id
entity_type   = workspace
entity_id     = collaboration_workspace_kind_id
role          = Owner | Developer
status        = approved
```

`Owner` means the Team is managed as a Workspace resource. `Developer` means a
personally owned Team is shared with the Workspace. `kinds.user_id` always
records the creating user and never stores a Workspace ID.

The current "authorize from my resources" API always writes `Developer` and
does not expose ownership selection. A resource created directly inside a
Workspace is granted with `Owner` by its creation service.

Workspace access to an execution environment:

```text
resource_type = Device
resource_id   = device_kind_id
entity_type   = workspace
entity_id     = collaboration_workspace_kind_id
role          = Owner | Developer
status        = approved
```

Execution environments use the same rule: `Owner` means Workspace-managed and
`Developer` means a shared personal resource.
The current "authorize from my resources" API also always writes `Developer`.

Project membership in a Workspace:

```text
resource_type = CloudProject
resource_id   = cloud_project_id
entity_type   = workspace
entity_id     = collaboration_workspace_kind_id
role          = Owner
status        = approved
```

One active CloudProject may belong to only one active collaboration workspace.
The service enforces this rule transactionally because the database does not
provide a conditional uniqueness constraint for this polymorphic relation.

## Assignment activity protocol

An Assignment is a structured `LoopItemComment`.

Assignment:

```json
{
  "event_type": "assignment",
  "action": "assign",
  "target_type": "human",
  "target_id": "123",
  "target_name": "Alice",
  "workflow_step": "Interaction design",
  "notify": true,
  "trigger": "manual"
}
```

Unassignment:

```json
{
  "event_type": "assignment",
  "action": "unassign",
  "assignment_event_id": "789",
  "target_type": "agent",
  "target_id": "456",
  "workflow_step": "Implementation"
}
```

Rules:

- The activity row's `loop_item_id` references the Issue.
- `description` contains the optional user comment.
- `metadata.event_type` distinguishes comments from system activity.
- The assignment activity ID is also the Assignment API ID.
- Active assignments are reduced from the Issue's ordered assignment activity.
- Services reject duplicate active assignments within the write transaction.
- Human assignment creates a notification.
- Agent assignment may create a Run through the existing execution policy.
- Assignment does not grant access or prevent other members from acting.

If cross-Issue active-assignment queries later become a measured bottleneck, a
rebuildable projection index may be introduced. It must not become another
source of truth.

## Structures not introduced

The final model does not contain:

```text
collaboration_workspaces
workspace_agent_bindings
workspace_execution_environments
workspace_kind_bindings
issue_assignments
loop_items.workspace_id
loop_item_executions.workspace_id
```

Migration code converts any data already written to those temporary structures
into `kinds`, `resource_members`, and Assignment activities, then removes the
temporary tables and columns.
