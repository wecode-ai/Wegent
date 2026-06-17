---
sidebar_position: 1
---

# Team Child Namespace Authorization

## Summary

Parent-group agents can be explicitly authorized for use by selected child groups.
The authorization is attached to the Team resource, not to the parent group itself.
Child group members can see and run authorized parent-group Teams, and runtime
dependencies configured on that Team continue to work. Child group members do not
gain parent-group management permissions and do not get direct access to browse or
select parent-group Skills or knowledge bases outside the authorized Team.

## Goals

- Allow a parent-group Team to be shared with one or more descendant group namespaces.
- Let members of authorized child groups see and run the parent-group Team.
- Let the authorized Team resolve and use its configured Bots, Skills, and default
  knowledge bases during task execution.
- Preserve existing GitLab-style group permission semantics for management actions.
- Prevent child groups from gaining direct access to unrelated parent-group resources.

## Non-Goals

- Do not make parent-group Teams automatically visible to every child group.
- Do not let child group members edit, delete, copy, or reconfigure parent-group Teams.
- Do not expose parent-group Skills or knowledge bases for direct selection in child
  group Team/Bot editors.
- Do not change `get_effective_role_in_group()` into upward permission inheritance.
- Do not introduce a new authorization table.

## Data Model

Reuse `resource_members` for Team-to-namespace authorization:

```text
resource_type = "Team"
resource_id = <parent Team id>
entity_type = "namespace"
entity_id = <child Namespace id>
role = "Reporter"
status = "approved"
```

`Reporter` means "can view and run this Team" for this feature. It must not be
treated as permission to manage the Team or its underlying parent-group resources.

## Authorization Rules

A Team can be authorized only to descendant namespaces of the Team namespace.

Examples:

```text
team.namespace = "parent"

allowed:    "parent/child-a"
allowed:    "parent/child-a/grandchild"
rejected:   "parent"
rejected:   "other"
rejected:   "default"
```

For group Teams, only users who can manage the Team in its own namespace may add,
update, or remove namespace authorizations. The target namespace role is fixed to
`Reporter`; requests attempting a stronger role for `entity_type="namespace"` on
Team resources must be rejected.

## Backend Changes

### Team Share Service

Extend `TeamShareService` around member management to validate namespace entity
targets:

- Resolve `entity_id` to `Namespace`.
- Reject non-descendant namespaces.
- Reject self-authorization to the Team namespace.
- Reject `default` namespace.
- Require role to be `Reporter`.

The existing `UnifiedShareService.check_permission()` and namespace entity resolver
already support `ResourceMember(entity_type="namespace")` for read checks, so this
feature should reuse that path.

### Team Listing

Update `TeamKindsService.get_user_teams()` to include Teams granted through
namespace entity membership.

For `scope="group"` with a specific `group_name`, the response should include:

- Teams native to `group_name`.
- Teams whose `resource_members` include `entity_type="namespace"` for this group,
  where the current user is a member of that namespace.

For `scope="all"`, include namespace-authorized Teams for all groups the user can
access. Deduplicate Teams already returned through native group membership or direct
user sharing.

### Team Detail

Keep using `team_share_service.get_resource()` as the access gate for Team detail.
This already delegates to `check_permission()` and can validate namespace entity
authorization.

### Task Creation

Update task creation to validate Team access by Team id through
`team_share_service.get_resource()` when `team_id` is provided. This avoids the
current failure mode where a Team appears in the list but task creation looks it up
only as a user-owned or same-namespace group Team.

When task creation succeeds, keep the task's `teamRef` pointing at the original
parent-group Team namespace/name and owner context so runtime resolution uses the
Team's real configuration.

### Runtime Dependencies

Authorized child-group use of a parent Team must allow only that Team's configured
dependencies:

- Bots referenced by the Team.
- Skills referenced by those Bots/Ghosts.
- Default knowledge bases referenced by those Bots.

This does not make parent-group Skills or knowledge bases generally selectable in
the child group UI. If a runtime permission check blocks an already-bound Team
dependency, add a narrow task/team-derived access path that validates the dependency
is referenced by the authorized Team.

## Frontend Changes

Add an authorization management entry in parent-group Team management:

- Show existing child-group authorizations for the selected Team.
- Let users with Team management permission choose descendant groups from the current
  Team namespace tree.
- Save by calling the existing share member endpoints for `Team`.
- Display authorized parent Teams in child-group Team lists as shared/read-only.
- Hide edit/delete controls for authorized parent Teams unless the user already has
  normal management permission in the Team's namespace.

## Error Handling

- Invalid target namespace: `400`.
- Target namespace is not a descendant of the Team namespace: `400` or `403`.
- Current user cannot manage the parent Team: `403`.
- Attempt to grant namespace Team authorization above Reporter: `400`.
- Authorized Team missing during task creation: `404`.
- Authorized Team dependency no longer exists: preserve current runtime missing-resource
  error behavior.

## Tests

Backend tests:

- Team namespace authorization accepts descendant namespaces.
- Team namespace authorization rejects self, parent, unrelated, and default namespaces.
- Child group member sees authorized parent Team in `scope=group`.
- Child group member can get Team detail through namespace authorization.
- Child group member can create a task using an authorized parent Team.
- Child group member cannot update or delete the authorized parent Team.
- Runtime dependency checks allow only dependencies referenced by the authorized Team.

Frontend tests:

- Parent Team management can add and remove child-group authorizations.
- Child group Team list shows authorized parent Teams as read-only.
- Edit/delete controls remain hidden for users without parent-group management rights.

## Migration

No database migration is required because `resource_members` already supports
`resource_type="Team"` and `entity_type="namespace"`.

## Open Decision

The first implementation should expose this only for Team resources. Direct
authorization of parent-group Skills or knowledge bases to child groups remains a
separate future feature.
